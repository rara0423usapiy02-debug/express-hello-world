// app.refactored.stable.js - LINE Messaging API webhook（高速応答・分散タップ抑止・管理者自己登録／祝席向け文面・観測性強化・安定化版）
"use strict";

/* ===== 主な強化点 =====
 * - 0.0.0.0 bind / PORT 準拠
 * - undici + AbortController による確実なタイムアウト
 * - TOKEN 未設定時は送信APIをスキップ（ログのみ）
 * - /health（軽量）と /ready（Redis ping 等）を分離
 * - 未処理例外/拒否のログ化と継続
 * - Quick Reply 13件上限順守
 * - JSON body size 制限
 */

const express = require("express");
const { randomUUID, createHmac, timingSafeEqual } = require("crypto");
const { Agent, fetch: undiciFetch } = require("undici");
let CacheableLookup; try { CacheableLookup = require("cacheable-lookup"); } catch {}
let pino; try { pino = require("pino"); } catch { pino = () => ({ info: console.log, warn: console.warn, error: console.error, debug: console.log }); }
const Redis = require("ioredis");
const prom = require("prom-client");

// ====== 環境変数 ======
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.LINE_ACCESS_TOKEN || ""; // 未設定でも落とさない
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const STRICT_SIGNATURE = /^true$/i.test(process.env.STRICT_SIGNATURE || "false");

const FAST_HTTP_EARLY_200 = !/^false$/i.test(process.env.FAST_HTTP_EARLY_200 || "true");
const TAP_DEBOUNCE_MS = Number(process.env.TAP_DEBOUNCE_MS || 1200);
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 5 * 60 * 1000);
const RATE_CAP = Number(process.env.RATE_CAP || 10);
const RATE_REFILL = Number(process.env.RATE_REFILL || 1);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 5000); // 全体目安
const DNS_CACHE_TTL = Number(process.env.DNS_CACHE_TTL || 0); // 0=無効, 秒

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_REG_TOKEN = process.env.ADMIN_REG_TOKEN || "";
const REDIS_URL = process.env.REDIS_URL || "";

const METRICS_USER = process.env.METRICS_USER || "";
const METRICS_PASS = process.env.METRICS_PASS || "";

// ====== ロガー ======
let logger;
try {
  logger = pino(process.env.NODE_ENV === "production" ? {} : { transport: { target: "pino-pretty" } });
} catch { logger = pino(); }

// ====== 起動前チェック ======
if (!TOKEN) logger.error("[WARN] LINE_ACCESS_TOKEN 未設定のため、Reply/Push は送信スキップします。");
if (!CHANNEL_SECRET) logger.warn("[WARN] LINE_CHANNEL_SECRET 未設定。STRICT_SIGNATURE=true の場合 403 になります。");

// ====== アプリ初期化 ======
const app = express();

// ====== 生ボディ保持（署名検証用）＋ サイズ制限 ======
function rawBodySaver(req, _res, buf, encoding) { if (buf && buf.length) req.rawBody = buf.toString(encoding || "utf8"); }
app.use(express.json({ verify: rawBodySaver, limit: process.env.BODY_LIMIT || "1mb" }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver, limit: process.env.BODY_LIMIT || "1mb" }));

// ====== 相関ID付与 ======
app.use((req, res, next) => {
  const rid = req.get("x-request-id") || randomUUID();
  req.rid = rid;
  res.setHeader("x-request-id", rid);
  const start = Date.now();
  res.on("finish", () => {
    logger.info({ rid, method: req.method, url: req.originalUrl, status: res.statusCode, elapsedMs: Date.now() - start }, "HTTP finished");
  });
  next();
});

logger.info({ PORT, FAST_HTTP_EARLY_200, REQUEST_TIMEOUT_MS, DNS_CACHE_TTL }, "[BOOT] starting");

// ====== Redis 初期化 ======
let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, { lazyConnect: false, enableAutoPipelining: true, maxRetriesPerRequest: 3 });
  redis.on("error", (err) => logger.error({ err: String(err) }, "[Redis] error"));
  redis.on("connect", () => logger.info({ REDIS_URL }, "[Redis] connected"));
  redis.on("close", () => logger.warn("[Redis] connection closed"));
  logger.info({ REDIS_URL }, "[BOOT] Redis enabled for dedupe/tapGuard/admins");
} else {
  logger.warn("[BOOT] Redis disabled, fallback to in-memory store");
}

// ====== undici Agent（HTTP/2/ALPN, Keep-Alive, 任意DNSキャッシュ） ======
const agentOpts = { keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000, connectTimeout: REQUEST_TIMEOUT_MS };
if (DNS_CACHE_TTL > 0 && CacheableLookup) {
  const cache = new CacheableLookup({ maxTtl: DNS_CACHE_TTL, errorTtl: 1, fallbackDuration: 0 });
  cache.install(require("dns"));
  agentOpts.lookup = cache.lookup;
  logger.info({ DNS_CACHE_TTL }, "[BOOT] DNS cache enabled");
} else if (DNS_CACHE_TTL > 0) {
  logger.warn("[BOOT] DNS cache requested but cacheable-lookup not installed. Skipping.");
}
const lineAgent = new Agent(agentOpts);

// **Abort 付き fetch（確実なタイムアウト）**
async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try { return await undiciFetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function lineFetch(path, { method = "GET", body, headers = {} } = {}) {
  return fetchWithTimeout("https://api.line.me" + path, {
    method,
    body,
    dispatcher: lineAgent,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...headers
    }
  });
}

// ====== Prometheus メトリクス ======
prom.collectDefaultMetrics();
const webhookHist = new prom.Histogram({ name: "line_webhook_duration_seconds", help: "Webhook processing time", buckets: [0.02, 0.05, 0.1, 0.3, 0.5, 1, 2] });
const replyCounter = new prom.Counter({ name: "line_reply_messages_total", help: "Total messages replied" });
const pushCounter = new prom.Counter({ name: "line_push_messages_total", help: "Total messages pushed" });
const rateLimitBlockCounter = new prom.Counter({ name: "line_ratelimit_block_total", help: "Rate limit blocks" });
const tapGuardBlockCounter = new prom.Counter({ name: "line_tapguard_block_total", help: "Tap guard (debounce) blocks" });

// ====== 共通ユーティリティ ======
const now = () => Date.now();
const elapsed = (t) => `${Date.now() - t}ms`;
const toISO = (d = new Date()) => d.toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const summarizeData = (data) => { try { return JSON.stringify(data).slice(0, 300); } catch { return String(data).slice(0, 300); } };

// ====== データ（サンプル応答） ======
const rabbitImages = [
  "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051997_0.jpg",
  "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051999_0.jpg",
  "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052000.jpg",
  "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052001.jpg",
  "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052002.jpg",
];

const faqData = {
  "駐車場": { q: "駐車場はありますか？", a: "会場には無料でご利用いただける駐車場がございます（最大78台）\nどうぞ安心してお越しください" },
  "服装": { q: "服装の指定はありますか？", a: "平服でお越しください\n男性はスーツ、女性はセミフォーマルがおすすめです\n屋外に出る場面もございますので羽織れる服が安心です" },
  "送迎バス": { q: "送迎バスの時間を変更したい", a: "招待状でご回答以外の便にもご乗車いただけます\nご都合に合わせてご利用ください" },
  "最終集合時間": { q: "最終集合時間は?", a: "13:15です\n11:45からウェルカムドリンクを提供しますので是非ご利用ください" },
  "更衣室": { q: "更衣室はありますか？", a: "館内1階に個室の更衣室がございます\n11:45からご利用いただけます!" },
};

// ====== メッセージ生成 ======
const createFaqListFlex = () => ({
  type: "flex",
  altText: "結婚式FAQリスト",
  contents: {
    type: "bubble",
    styles: { body: { backgroundColor: "#FFF0F5" } },
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: " 結婚式 FAQ 🕊️", weight: "bold", size: "lg", align: "center", color: "#C19A6B" },
        { type: "separator", margin: "md", color: "#E6C9C9" },
        ...Object.keys(faqData).map((key, i) => ({
          type: "button",
          style: "secondary",
          color: ["#FADADD", "#D5E8D4", "#DDEBF7"][i % 3],
          action: { type: "message", label: faqData[key].q, text: "FAQ:" + key },
          margin: "sm",
        })),
      ],
    },
  },
});

const createFaqAnswerFlex = (key) => ({
  type: "flex",
  altText: faqData[key]?.q || "ご案内",
  contents: {
    type: "bubble",
    styles: { body: { backgroundColor: "#FFFAF0" } },
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "Q. " + (faqData[key]?.q || "ご案内"), weight: "bold", size: "md", color: "#C19A6B" },
        { type: "text", text: "A. " + (faqData[key]?.a || "ただいまご案内のご用意がありませんでした。"), wrap: true, size: "sm", margin: "md", color: "#333333" },
      ],
    },
  },
});

const createRandomRabbitImage = () => {
  const img = rabbitImages[Math.floor(Math.random() * rabbitImages.length)];
  return [{ type: "image", originalContentUrl: img, previewImageUrl: img }];
};

// ====== Quick Reply ヘルパ ======
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const compact = messages.filter(Boolean);
  const MAX_REPLY_MESSAGES = 5;
  return compact.slice(0, MAX_REPLY_MESSAGES);
}
function withQuickReply(messages, items = []) {
  const compact = sanitizeMessages(messages);
  if (compact.length === 0) return compact;
  if (!Array.isArray(items) || items.length === 0) return compact;
  // LINE Quick Reply items 上限は 13
  const qItems = items
    .filter(i => i && i.label && i.text)
    .slice(0, 13)
    .map(i => ({ type: "action", action: { type: "message", label: i.label, text: i.text } }));
  if (qItems.length === 0) return compact;
  const [head, ...rest] = compact;
  return [{ ...head, quickReply: { items: qItems } }, ...rest];
}
function stripEmptyQuickReply(messages) {
  return (messages || []).map(m => {
    if (m && m.quickReply && (!Array.isArray(m.quickReply.items) || m.quickReply.items.length === 0)) {
      const { quickReply, ...rest } = m;
      return rest;
    }
    return m;
  });
}

// ====== 管理者（自己登録） ======
const adminsMem = new Set();
async function isAdmin(userId) {
  if (!userId) return false;
  if (ADMIN_USER_IDS.includes(userId)) return true;
  if (redis) return (await redis.sismember("admins", userId)) === 1;
  return adminsMem.has(userId);
}

// ====== ルーター ======
const routes = [
  {
    match: /^admin[:\s]+register\s+(\S+)$/i,
    handle: async (_text, m, event) => {
      if (!ADMIN_REG_TOKEN) return [{ type: "text", text: "現在、管理者の自己登録はご利用いただけません。" }];
      const token = m[1];
      if (token !== ADMIN_REG_TOKEN) return [{ type: "text", text: "合言葉が一致しませんでした。" }];
      if (event.source?.type !== "user" || !event.source.userId) return [{ type: "text", text: "個別トークでお試しください。" }];
      const uid = event.source.userId;
      if (redis) await redis.sadd("admins", uid); else adminsMem.add(uid);
      return [{ type: "text", text: "管理者として登録いたしました。いつもありがとうございます。" }];
    }
  },
  {
    match: /^admin[:\s]+unregister$/i,
    handle: async (_text, _m, event) => {
      if (event.source?.type !== "user" || !event.source.userId) return [{ type: "text", text: "個別トークでお試しください。" }];
      const uid = event.source.userId;
      if (redis) await redis.srem("admins", uid); else adminsMem.delete(uid);
      return [{ type: "text", text: "管理者登録を解除いたしました。引き続きよろしくお願いいたします。" }];
    }
  },
  {
    match: /^admin[:\s]+(stats|status)$/i,
    handle: async (_text, _m, event) => {
      const uid = event.source?.userId;
      if (await isAdmin(uid)) {
        const mem = process.memoryUsage();
        const body = [
          `uptimeSec: ${Math.floor(process.uptime())}`,
          `rssMB: ${(mem.rss / 1024 / 1024).toFixed(1)}`,
          `heapUsedMB: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}`,
          `perKeyQueues: ${perKeyQueue.size}`,
          `seenCacheSize: ${seenSize()}`,
          `tapGuardSize: ${tapGuardSize()}`,
          `rateEntries: ${rate.size}`,
          `redis: ${!!redis}`,
        ].join("\n");
        return [{ type: "text", text: body }];
      }
      return [{ type: "text", text: "権限対象ではございません。" }];
    }
  },
  { match: /^faq$/i, handle: async () => [createFaqListFlex()] },
  { match: /^faq:(.+)$/i, handle: async (_t, m) => { const key = m[1].trim(); return faqData[key] ? [createFaqAnswerFlex(key)] : null; } },
  { match: /\bhuku\b/i, handle: async () => createRandomRabbitImage() },
  { match: /^test$/i, handle: async () => [{ type: "text", text: "Hello, user" }, { type: "text", text: "May I help you?" }] },
];

async function routeMessage(text, event) {
  for (const r of routes) {
    const m = text.match(r.match);
    if (m) return await r.handle(text, m, event);
  }
  return null; // ヒットしなければ沈黙
}

// ====== 署名検証 ======
function validateSignature(req) {
  if (!CHANNEL_SECRET) return { ok: true, reason: "no-secret" };
  const signature = req.get("x-line-signature");
  if (!signature || !req.rawBody) return { ok: false, reason: "missing" };
  const digest = createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
  const sigBuf = Buffer.from(signature, "base64");
  const digBuf = Buffer.from(digest, "base64");
  if (sigBuf.length !== digBuf.length) return { ok: false, reason: "length-mismatch" };
  const ok = timingSafeEqual(sigBuf, digBuf);
  return { ok, reason: ok ? "match" : "mismatch" };
}

// ====== 返信/Push（undici + リトライ） ======
function ensureSendable() {
  if (!TOKEN) {
    logger.warn("[Reply/Push] skipped: LINE_ACCESS_TOKEN not set");
    return false;
  }
  return true;
}

async function replyWithRetry(eventId, replyToken, rawMessages) {
  const start = now();
  const messages = stripEmptyQuickReply(sanitizeMessages(rawMessages));
  if (messages.length === 0) { logger.warn({ eventId }, "[Reply Skip] no-messages"); return; }
  if (!ensureSendable()) return;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await lineFetch("/v2/bot/message/reply", {
        method: "POST",
        body: JSON.stringify({ replyToken, messages })
      });
      if (resp.ok) {
        replyCounter.inc(messages.length);
        logger.info({ eventId, status: resp.status, attempt, elapsed: elapsed(start), size: messages.length }, "LINE Reply OK");
        return;
      }
      const retryAfterSec = parseInt(resp.headers.get("retry-after") || "0", 10);
      const bodyText = await resp.text().catch(() => "");
      logger.error({ eventId, attempt, status: resp.status, data: summarizeData(bodyText), elapsed: elapsed(start) }, "LINE Reply error");
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        const backoff = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(2000 * Math.pow(2, attempt - 1), 8000);
        await sleep(backoff); continue;
      }
      const err = new Error(`Reply failed ${resp.status}: ${bodyText}`); err.response = { status: resp.status }; throw err;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(Math.min(2000 * Math.pow(2, attempt - 1), 8000));
    }
  }
}

async function pushWithRetry(to, rawMessages) {
  const start = now();
  const messages = stripEmptyQuickReply(sanitizeMessages(rawMessages));
  if (messages.length === 0) return;
  if (!ensureSendable()) return;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await lineFetch("/v2/bot/message/push", {
        method: "POST",
        body: JSON.stringify({ to, messages })
      });
      if (resp.ok) {
        pushCounter.inc(messages.length);
        logger.info({ to, status: resp.status, attempt, elapsed: elapsed(start), size: messages.length }, "LINE Push OK");
        return;
      }
      const retryAfterSec = parseInt(resp.headers.get("retry-after") || "0", 10);
      const bodyText = await resp.text().catch(() => "");
      logger.error({ to, attempt, status: resp.status, data: summarizeData(bodyText), elapsed: elapsed(start) }, "LINE Push error");
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        const backoff = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(2000 * Math.pow(2, attempt - 1), 8000);
        await sleep(backoff); continue;
      }
      const err = new Error(`Push failed ${resp.status}: ${bodyText}`); err.response = { status: resp.status }; throw err;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(Math.min(2000 * Math.pow(2, attempt - 1), 8000));
    }
  }
}

async function replyWithRetryOrPush(event, rawMessages) {
  const eventId = event.webhookEventId || "no-id";
  try {
    await replyWithRetry(eventId, event.replyToken, rawMessages);
  } catch (e) {
    const status = e.response?.status;
    if ((status >= 400 && status < 500) && event.source?.type === "user" && event.source.userId) {
      logger.warn({ eventId, status }, "Reply failed -> Push fallback");
      await pushWithRetry(event.source.userId, rawMessages);
    } else { throw e; }
  }
}

// ====== デデュープ（再配送/重複ID） ======
const seenMem = new Map(); // id -> expireAt
setInterval(() => { if (redis) return; const t = now(); for (const [k, v] of seenMem.entries()) if (v <= t) seenMem.delete(k); }, 60 * 1000).unref();
function eventKey(e) { if (e.webhookEventId) return `id:${e.webhookEventId}`; return `${e.type}:${e.message?.id || ""}:${e.timestamp || ""}`; }
async function isDuplicate(event) {
  const key = eventKey(event);
  if (redis) { const ok = await redis.set(`dedupe:${key}`, "1", "PX", DEDUPE_TTL_MS, "NX"); return ok !== "OK"; }
  else { const t = now(); const exp = seenMem.get(key); if (exp && exp > t) return true; seenMem.set(key, t + DEDUPE_TTL_MS); return false; }
}
function seenSize() { return redis ? -1 : seenMem.size; }

// ====== ログ整形（合言葉は伏字化） ======
function safeLogEvent(e, rid) {
  let txt = e.message?.text;
  if (typeof txt === "string" && /^admin[:\s]+register\s+\S+/i.test(txt)) txt = "admin:register ******";
  const base = { rid, eventId: e.webhookEventId || null, type: e.type, source: e.source?.type, msgType: e.message?.type, text: txt };
  logger.info(base, "[Webhook Event]");
}

// ====== ダブルタップ抑止（タップガード） ======
const tapMem = new Map(); // mapKey -> expireAt
setInterval(() => { if (redis) return; const t = Date.now(); for (const [k, exp] of tapMem.entries()) if (exp <= t) tapMem.delete(k); }, 60 * 1000).unref();
function normalizePayloadText(s) { return String(s || "").trim().toLowerCase(); }
async function tapGuardAccept(userOrGroupKey, payloadText) {
  const norm = normalizePayloadText(payloadText);
  const mapKey = `${userOrGroupKey}|${norm}`;
  if (redis) {
    const ok = await redis.set(`tap:${mapKey}`, "1", "PX", TAP_DEBOUNCE_MS, "NX");
    const accept = ok === "OK"; if (!accept) tapGuardBlockCounter.inc(); return accept;
  } else {
    const t = Date.now(); const exp = tapMem.get(mapKey);
    if (exp && exp > t) { tapGuardBlockCounter.inc(); return false; }
    tapMem.set(mapKey, t + TAP_DEBOUNCE_MS); return true;
  }
}
function tapGuardSize() { return redis ? -1 : tapMem.size; }

// ====== レート制限（ユーザー単位 簡易トークンバケット） ======
const rate = new Map(); // key -> { tokens, updatedAt }
function allowRate(key) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cur = rate.get(key) || { tokens: RATE_CAP, updatedAt: nowSec };
  const refill = (nowSec - cur.updatedAt) * RATE_REFILL;
  const tokens = Math.min(RATE_CAP, cur.tokens + refill);
  if (tokens < 1) { rate.set(key, { tokens, updatedAt: nowSec }); rateLimitBlockCounter.inc(); return false; }
  rate.set(key, { tokens: tokens - 1, updatedAt: nowSec }); return true;
}

// ====== キュー制御（per-key 直列実行） ======
const perKeyQueue = new Map(); // key -> Promise chain
function keyFromEvent(e) {
  if (e.source?.type === "user") return `user:${e.source.userId || "unknown"}`;
  if (e.source?.type === "group") return `group:${e.source.groupId || "unknown"}`;
  if (e.source?.type === "room") return `room:${e.source.roomId || "unknown"}`;
  return "unknown";
}
function lockPerKeyAndRun(key, taskFn) {
  const prev = perKeyQueue.get(key) || Promise.resolve();
  const run = prev
    .catch(() => {}) // 直前のエラーは握りつぶして続行
    .then(() => taskFn())
    .finally(() => { if (perKeyQueue.get(key) === run) perKeyQueue.delete(key); });
  perKeyQueue.set(key, run);
  return run;
}

// ====== イベント処理（1件） ======
async function processEvent(event, rid) {
  const eventId = event.webhookEventId || "no-id";

  if (event?.deliveryContext?.isRedelivery) { logger.info({ rid, eventId }, "[Skip] Redelivery"); return; }
  if (await isDuplicate(event)) { logger.info({ rid, eventId }, "[Skip] Duplicate"); return; }

  const userKey = keyFromEvent(event);
  if (!allowRate(userKey)) { logger.warn({ rid, eventId, userKey }, "[RateLimit] Too many requests"); return; }

  safeLogEvent(event, rid);

  if (event.type === "follow") { logger.info({ rid, eventId }, "[Info] follow event -> no-op"); return; }

  if (event.type === "postback") {
    const data = String(event.postback?.data || "");
    if (!(await tapGuardAccept(userKey, data))) {
      logger.info({ rid, eventId, userKey, data, windowMs: TAP_DEBOUNCE_MS }, "[TapGuard] duplicate postback"); return;
    }
    if (data.startsWith("faq:")) {
      const key = decodeURIComponent(data.slice(4));
      const msgs = faqData[key] ? [createFaqAnswerFlex(key)] : null;
      if (msgs) await replyWithRetryOrPush(event, msgs);
    }
    return;
  }

  if (event.type === "message" && event.message?.type === "text" && event.replyToken) {
    if (!(await tapGuardAccept(userKey, event.message.text))) {
      logger.info({ rid, eventId, userKey, text: event.message.text, windowMs: TAP_DEBOUNCE_MS }, "[TapGuard] duplicate tap"); return;
    }
    const msgs = await routeMessage(event.message.text.trim(), event);
    if (msgs && msgs.length > 0) { await replyWithRetryOrPush(event, msgs); }
    return;
  }

  logger.info({ rid, eventId, type: event.type }, "[Info] Unsupported event type -> no-op");
}

// ====== 健康チェック/レディネス/メトリクス ======
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/webhook", (_req, res) => res.status(200).send("webhook ok"));
app.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.status(200).json({
    ok: true, ts: toISO(), uptimeSec: Math.floor(process.uptime()),
    perKeyQueues: perKeyQueue.size, seenCacheSize: seenSize(), tapGuardSize: tapGuardSize(),
    tapWindowMs: TAP_DEBOUNCE_MS, rateEntries: rate.size, redis: !!redis,
    memory: { rssMB: +(mem.rss / 1024 / 1024).toFixed(1), heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1) },
    early200: FAST_HTTP_EARLY_200,
  });
});
app.get("/ready", async (_req, res) => {
  try {
    if (redis) { await redis.ping(); }
    return res.status(200).json({ ready: true, redis: !!redis });
  } catch (e) {
    logger.warn({ err: String(e) }, "[Ready] dependency not ready");
    return res.status(503).json({ ready: false, error: String(e) });
  }
});
// /metrics（Basic 認証任意）
app.get("/metrics", async (req, res) => {
  if (METRICS_USER && METRICS_PASS) {
    const hdr = req.headers.authorization || "";
    let u = "", p = "";
    if (hdr.startsWith("Basic ")) {
      try { [u, p] = Buffer.from(hdr.slice(6), "base64").toString().split(":"); } catch { /* noop */ }
    }
    if (u !== METRICS_USER || p !== METRICS_PASS) return res.status(401).set("WWW-Authenticate", "Basic realm=metrics").end();
  }
  res.set("Content-Type", prom.register.contentType);
  res.end(await prom.register.metrics());
});

// ====== Webhook ======
app.post("/webhook", async (req, res) => {
  const rid = req.rid;
  const sig = validateSignature(req);
  if (!sig.ok) {
    logger.warn({ rid, sig }, "[WARN] Invalid signature");
    if (STRICT_SIGNATURE) return res.sendStatus(403);
    return res.sendStatus(200);
  }

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (events.length === 0) { logger.info({ rid }, "[Webhook] No events"); return res.sendStatus(200); }

  const endTimer = webhookHist.startTimer();
  const start = now();

  if (FAST_HTTP_EARLY_200) {
    res.sendStatus(200);
    queueMicrotask(async () => {
      try {
        const tasks = events.map(ev => lockPerKeyAndRun(keyFromEvent(ev), () => processEvent(ev, rid)));
        await Promise.allSettled(tasks);
      } catch (e) {
        logger.error({ rid, err: e.stack || String(e) }, "[Webhook Handling Error BG]");
      } finally {
        endTimer();
        logger.info({ rid, elapsed: elapsed(start) }, "[Webhook Async Done]");
      }
    });
  } else {
    try {
      for (const ev of events) {
        const key = keyFromEvent(ev);
        await lockPerKeyAndRun(key, async () => processEvent(ev, rid));
      }
      endTimer();
      res.sendStatus(200);
    } catch (e) {
      logger.error({ rid, err: e.stack || String(e) }, "[Webhook Handling Error]");
      endTimer();
      res.sendStatus(500);
    } finally {
      logger.info({ rid, elapsed: elapsed(start) }, "[Webhook Sync Done]");
    }
  }
});

// ====== 起動/終了 ======
const server = app.listen(PORT, "0.0.0.0", () => { logger.info(`Server running at http://0.0.0.0:${PORT}`); });

function shutdown(code = 0) {
  logger.info("[Shutdown] closing server...");
  // 猶予15s（キュー中処理の完了を待ちやすく）
  const force = setTimeout(() => { logger.warn("[Shutdown] force exit after timeout"); process.exit(code); }, 15000).unref();
  server.close(async () => {
    try { if (redis) await redis.quit(); } catch (e) { logger.warn({ e: String(e) }, "[Shutdown] redis.quit error"); }
    clearTimeout(force);
    logger.info("[Shutdown] closed. Bye.");
    process.exit(code);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
// 落ちない方針：ログだけ出して継続（必要なら exit(1) に変更）
process.on("unhandledRejection", (r) => logger.error({ err: String(r) }, "[Warn] unhandledRejection"));
process.on("uncaughtException", (e) => logger.error({ err: String(e?.stack || e) }, "[Fatal] uncaughtException"));
