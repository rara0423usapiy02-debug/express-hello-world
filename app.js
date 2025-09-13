// app.refactored.js - LINE Messaging API webhook（同期処理・分散タップ抑止・管理者自己登録対応／祝席向け文面・観測性強化）
// 変更点サマリはチャット側で説明。既存 app.js と差し替え可能な単一ファイル構成。
"use strict";

/**
 * ■ 本ファイルの主な改善点（詳細はチャットのステップで説明）
 * - reply/push 双方に指数バックオフリトライを実装（Push も安定化）
 * - Quick Reply が空のとき 400 を回避する二重防御（送信直前も除去）
 * - Redis イベント監視・終了時の安全なクローズ
 * - /metrics に簡易 Basic 認証（任意）
 * - 署名検証の強化（欠落や改ざん時のログ粒度向上）
 * - ログの構造化強化（エラー時ヘッダ/応答本文の要約）
 * - 健康チェックの拡充（メモリ使用量・Redis状態）
 * - いくつかの視認性/保守性リファクタ（関数分割・命名・コメント）
 */

const express = require("express");
const axios = require("axios");
const { randomUUID, createHmac, timingSafeEqual } = require("crypto");
const http = require("http");
const https = require("https");

// ---- pino は未インストールでも動くフォールバック ----
let pino;
try { pino = require("pino"); }
catch { pino = () => ({ info: console.log, warn: console.warn, error: console.error, debug: console.log }); }

const Redis = require("ioredis");
const prom = require("prom-client"); // Prometheus

// ====== 環境変数 ======
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.LINE_ACCESS_TOKEN || ""; // 必須
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || ""; // 推奨
const STRICT_SIGNATURE = /^true$/i.test(process.env.STRICT_SIGNATURE || "false");
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 5000);

// デバウンス（タップガード）とデデュープの TTL
const TAP_DEBOUNCE_MS = Number(process.env.TAP_DEBOUNCE_MS || 1200);
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 5 * 60 * 1000);

// レート制限（ユーザー単位トークンバケット）
const RATE_CAP = Number(process.env.RATE_CAP || 10); // バースト上限
const RATE_REFILL = Number(process.env.RATE_REFILL || 1); // 1秒あたり回復数

// 管理者リスト（固定許可、カンマ区切り）
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
// 管理者 自己登録の合言葉（設定時のみ有効）
const ADMIN_REG_TOKEN = process.env.ADMIN_REG_TOKEN || "";

// Redis（任意）：指定時はデデュープ/タップガード/管理者セットを分散共有
const REDIS_URL = process.env.REDIS_URL || "";
let redis = null;
if (REDIS_URL) {
    redis = new Redis(REDIS_URL, {
        lazyConnect: false,
        enableAutoPipelining: true,
        maxRetriesPerRequest: 3,
    });
    redis.on("error", (err) => logger.error({ err: String(err) }, "[Redis] error"));
    redis.on("connect", () => logger.info({ REDIS_URL }, "[Redis] connected"));
    redis.on("close", () => logger.warn("[Redis] connection closed"));
}

// ====== ロガー ======
let logger;
try {
    logger = pino(process.env.NODE_ENV === "production" ? {} : { transport: { target: "pino-pretty" } });
} catch {
    // pino-pretty が無くても起動
    logger = pino();
}

// ====== 起動前チェック ======
if (!TOKEN) {
    // 起動だけ確認したい運用もあるため致命ではないが、明示ログを出す
    logger.error("[FATAL] LINE_ACCESS_TOKEN が未設定です。返信/Push は必ず失敗します。");
}
if (!CHANNEL_SECRET) {
    logger.warn("[WARN] LINE_CHANNEL_SECRET 未設定（署名検証をスキップ可能）。STRICT_SIGNATURE=true の場合は 403 返却。");
}

// ====== アプリ初期化 ======
const app = express();

// ====== 生ボディ保持（署名検証用） ======
function rawBodySaver(req, _res, buf, encoding) {
    if (buf && buf.length) req.rawBody = buf.toString(encoding || "utf8");
}
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));

// ====== 相関ID付与ミドルウェア ======
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

logger.info({ PORT }, "[BOOT] starting");
if (redis) logger.info({ REDIS_URL }, "[BOOT] Redis enabled for dedupe/tapGuard/admins");
else logger.warn("[BOOT] Redis disabled, fallback to in-memory store");

// ====== Keep-Alive Axios（LINE API用） ======
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 100, maxFreeSockets: 20 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 100, maxFreeSockets: 20 });
const line = axios.create({
    baseURL: "https://api.line.me",
    timeout: AXIOS_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    httpAgent: keepAliveHttpAgent,
    httpsAgent: keepAliveHttpsAgent,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
});

// ====== Prometheus メトリクス ======
prom.collectDefaultMetrics();
const webhookHist = new prom.Histogram({ name: "line_webhook_duration_seconds", help: "Webhook processing time", buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10] });
const replyCounter = new prom.Counter({ name: "line_reply_messages_total", help: "Total messages replied" });
const pushCounter = new prom.Counter({ name: "line_push_messages_total", help: "Total messages pushed" });
const rateLimitBlockCounter = new prom.Counter({ name: "line_ratelimit_block_total", help: "Rate limit blocks" });
const tapGuardBlockCounter = new prom.Counter({ name: "line_tapguard_block_total", help: "Tap guard (debounce) blocks" });

// ====== 共通ユーティリティ ======
const now = () => Date.now();
const elapsed = (t) => `${Date.now() - t}ms`;
const toISO = (d = new Date()) => d.toISOString();

// ====== データ（サンプル応答） ======
const rabbitImages = [
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051997_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051999_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052000.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052001.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052002.jpg",
];

const faqData = {
    "駐車場": { q: "駐車場はありますか？", a: "会場には無料でご利用いただける駐車場がございます（最大78台）。どうぞ安心してお越しください。" },
    "服装": { q: "服装の指定はありますか？", a: "平服でお越しください。男性はスーツ、女性はセミフォーマルがおすすめです。屋外に出る場面もございますので羽織れる服が安心です。" },
    "送迎バス": { q: "送迎バスの時間を変更したい", a: "招待状でご回答以外の便にもご乗車いただけます。ご都合に合わせてご利用ください。" },
    "大宮からタクシー": { q: "大宮駅からタクシー", a: "5～10分ほどで到着いたします（交通事情により前後します）。西口よりご乗車ください。" },
    "更衣室": { q: "更衣室はありますか？", a: "館内1階に個室の更衣室がございます。11:45からご利用いただけます。" },
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

// ====== Quick Reply ヘルパ（空なら付けない） ======
function withQuickReply(messages, items = []) {
    const compact = sanitizeMessages(messages);
    if (compact.length === 0) return compact;
    if (!Array.isArray(items) || items.length === 0) return compact; // ★空は付けない（400対策）
    const qItems = items
        .filter(i => i && i.label && i.text)
        .map(i => ({ type: "action", action: { type: "message", label: i.label, text: i.text } }));
    if (qItems.length === 0) return compact; // ★空は付けない（二重ガード）
    const [head, ...rest] = compact;
    return [{ ...head, quickReply: { items: qItems } }, ...rest];
}

// 送信直前の保険：空 quickReply を剥がす
function stripEmptyQuickReply(messages) {
    return (messages || []).map(m => {
        if (m && m.quickReply && (!Array.isArray(m.quickReply.items) || m.quickReply.items.length === 0)) {
            const { quickReply, ...rest } = m;
            return rest;
        }
        return m;
    });
}

// ====== 管理者（自己登録）ユーティリティ ======
const adminsMem = new Set(); // Redis未使用時の動的管理者
async function isAdmin(userId) {
    if (!userId) return false;
    if (ADMIN_USER_IDS.includes(userId)) return true;
    if (redis) return (await redis.sismember("admins", userId)) === 1;
    return adminsMem.has(userId);
}

// ====== ルーター（拡張容易） ======
const routes = [
    // 管理者：自己登録（コロン/空白どちらでもOK）
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
    // 管理者：解除
    {
        match: /^admin[:\s]+unregister$/i,
        handle: async (_text, _m, event) => {
            if (event.source?.type !== "user" || !event.source.userId) return [{ type: "text", text: "個別トークでお試しください。" }];
            const uid = event.source.userId;
            if (redis) await redis.srem("admins", uid); else adminsMem.delete(uid);
            return [{ type: "text", text: "管理者登録を解除いたしました。引き続きよろしくお願いいたします。" }];
        }
    },
    // 管理者：ステータス（stats / status 両対応・コロン/空白OK）
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
    // 一般機能
    { match: /^faq$/i, handle: async () => [createFaqListFlex()] },
    { match: /^faq:(.+)$/i, handle: async (_t, m) => { const key = m[1].trim(); return faqData[key] ? [createFaqAnswerFlex(key)] : [{ type: "text", text: "ただいまご案内のご用意がありませんでした。" }]; } },
    { match: /\bhuku\b/i, handle: async () => createRandomRabbitImage() },
    { match: /^test$/i, handle: async () => [{ type: "text", text: "Hello, user" }, { type: "text", text: "May I help you?" }] },
];

async function routeMessage(text, event) {
    for (const r of routes) {
        const m = text.match(r.match);
        if (m) return await r.handle(text, m, event);
    }
    return null;
}

// ====== 署名検証 ======
function validateSignature(req) {
    if (!CHANNEL_SECRET) return { ok: true, reason: "no-secret" };
    const signature = req.get("x-line-signature");
    if (!signature || !req.rawBody) return { ok: false, reason: "missing" };
    const digest = createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
    // timingSafeEqual で比較（長さ違いは即 false）
    const sigBuf = Buffer.from(signature);
    const digBuf = Buffer.from(digest);
    if (sigBuf.length !== digBuf.length) return { ok: false, reason: "length-mismatch" };
    const ok = timingSafeEqual(sigBuf, digBuf);
    return { ok, reason: ok ? "match" : "mismatch" };
}

// ====== 返信/Push（リトライ付） ======
const MAX_REPLY_MESSAGES = 5;

function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const compact = messages.filter(Boolean);
    return compact.slice(0, MAX_REPLY_MESSAGES);
}

async function replyWithRetry(eventId, replyToken, rawMessages) {
    const start = now();
    const messages = stripEmptyQuickReply(sanitizeMessages(rawMessages));
    if (messages.length === 0) {
        logger.warn({ eventId }, "[Reply Skip] no-messages");
        return;
    }
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const resp = await line.post("/v2/bot/message/reply", { replyToken, messages });
            replyCounter.inc(messages.length);
            logger.info({ eventId, status: resp.status, attempt, elapsed: elapsed(start), size: messages.length }, "LINE Reply OK");
            return;
        } catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            const retryAfterSec = parseInt(err.response?.headers?.["retry-after"] || "0", 10);
            logger.error({ eventId, attempt, status, data: summarizeData(data), elapsed: elapsed(start) }, "LINE Reply error");
            if (status === 429 || (status >= 500 && status < 600)) {
                const backoff = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(2000 * Math.pow(2, attempt - 1), 8000);
                await sleep(backoff);
                continue;
            }
            throw err; // 4xx は呼び出し側で Push フォールバック
        }
    }
}

async function pushWithRetry(to, rawMessages) {
    const start = now();
    const messages = stripEmptyQuickReply(sanitizeMessages(rawMessages));
    if (messages.length === 0) return;
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const resp = await line.post("/v2/bot/message/push", { to, messages });
            pushCounter.inc(messages.length);
            logger.info({ to, status: resp.status, attempt, elapsed: elapsed(start), size: messages.length }, "LINE Push OK");
            return;
        } catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            const retryAfterSec = parseInt(err.response?.headers?.["retry-after"] || "0", 10);
            logger.error({ to, attempt, status, data: summarizeData(data), elapsed: elapsed(start) }, "LINE Push error");
            if (status === 429 || (status >= 500 && status < 600)) {
                const backoff = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(2000 * Math.pow(2, attempt - 1), 8000);
                await sleep(backoff);
                continue;
            }
            throw err;
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
        } else {
            throw e;
        }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function summarizeData(data) {
    try { return JSON.stringify(data).slice(0, 300); } catch { return String(data).slice(0, 300); }
}

// ====== デデュープ（再配送/重複ID） ======
const seenMem = new Map(); // id -> expireAt（メモリ用）
setInterval(() => {
    if (redis) return;
    const t = now();
    for (const [k, v] of seenMem.entries()) if (v <= t) seenMem.delete(k);
}, 60 * 1000).unref();

function eventKey(e) {
    if (e.webhookEventId) return `id:${e.webhookEventId}`;
    return `${e.type}:${e.message?.id || ""}:${e.timestamp || ""}`;
}

async function isDuplicate(event) {
    const key = eventKey(event);
    if (redis) {
        // SET PX TTL NX -> if OK, first seen; else duplicate
        const ok = await redis.set(`dedupe:${key}`, "1", "PX", DEDUPE_TTL_MS, "NX");
        return ok !== "OK";
    } else {
        const t = now();
        const exp = seenMem.get(key);
        if (exp && exp > t) return true;
        seenMem.set(key, t + DEDUPE_TTL_MS);
        return false;
    }
}
function seenSize() { return redis ? -1 : seenMem.size; }

// ====== ログ整形（合言葉は伏字化） ======
function safeLogEvent(e, rid) {
    let txt = e.message?.text;
    if (typeof txt === "string" && /^admin[:\s]+register\s+\S+/i.test(txt)) txt = "admin:register ******";
    const base = { rid, eventId: e.webhookEventId || null, type: e.type, source: e.source?.type, msgType: e.message?.type, text: txt };
    logger.info(base, "[Webhook Event]");
}

// ====== ダブルタップ抑止（タップガード：Redis or メモリ） ======
const tapMem = new Map(); // mapKey -> expireAt（メモリ用）
setInterval(() => {
    if (redis) return;
    const t = Date.now();
    for (const [k, exp] of tapMem.entries()) if (exp <= t) tapMem.delete(k);
}, 60 * 1000).unref();

function normalizePayloadText(s) { return String(s || "").trim().toLowerCase(); }
async function tapGuardAccept(userOrGroupKey, payloadText) {
    const norm = normalizePayloadText(payloadText);
    const mapKey = `${userOrGroupKey}|${norm}`;
    if (redis) {
        const ok = await redis.set(`tap:${mapKey}`, "1", "PX", TAP_DEBOUNCE_MS, "NX");
        const accept = ok === "OK";
        if (!accept) tapGuardBlockCounter.inc();
        return accept;
    } else {
        const t = Date.now();
        const exp = tapMem.get(mapKey);
        if (exp && exp > t) { tapGuardBlockCounter.inc(); return false; }
        tapMem.set(mapKey, t + TAP_DEBOUNCE_MS);
        return true;
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
    if (tokens < 1) {
        rate.set(key, { tokens, updatedAt: nowSec });
        rateLimitBlockCounter.inc();
        return false;
    }
    rate.set(key, { tokens: tokens - 1, updatedAt: nowSec });
    return true;
}

// ====== キュー制御（同期版 per-key ロック） ======
const perKeyQueue = new Map(); // key -> Promise chain

function keyFromEvent(e) {
    if (e.source?.type === "user") return `user:${e.source.userId || "unknown"}`;
    if (e.source?.type === "group") return `group:${e.source.groupId || "unknown"}`;
    if (e.source?.type === "room") return `room:${e.source.roomId || "unknown"}`;
    return "unknown";
}

/**
 * 同期版：同じ key の処理を直列化し、caller にも待ってもらう
 * 戻り値: 現在の処理が完了する Promise
 */
function lockPerKeyAndRun(key, taskFn) {
    const prev = perKeyQueue.get(key) || Promise.resolve();
    const run = prev
        .catch(() => { /* 直前のエラーは握りつぶして続行 */ })
        .then(() => taskFn())
        .finally(() => { if (perKeyQueue.get(key) === run) perKeyQueue.delete(key); });
    perKeyQueue.set(key, run);
    return run;
}

// ====== イベント処理 ======
async function processEvent(event, rid) {
    const eventId = event.webhookEventId || "no-id";

    if (event?.deliveryContext?.isRedelivery) {
        logger.info({ rid, eventId }, "[Skip] Redelivery");
        return;
    }
    if (await isDuplicate(event)) {
        logger.info({ rid, eventId }, "[Skip] Duplicate");
        return;
    }

    // レート制限（ユーザー/グループ単位）
    const userKey = keyFromEvent(event);
    if (!allowRate(userKey)) {
        logger.warn({ rid, eventId, userKey }, "[RateLimit] Too many requests");
        return;
    }

    safeLogEvent(event, rid);

    // follow（祝席向け文面）
    if (event.type === "follow" && event.replyToken) {
        await replyWithRetryOrPush(event, [
            { type: "text", text: "追加ありがとうございます。\nこのトークルームは、当日も利用しますのでよろしくお願いいたします！" }
        ]);
        return;
    }

    // postback
    if (event.type === "postback" && event.replyToken) {
        const data = String(event.postback?.data || "");
        if (!(await tapGuardAccept(userKey, data))) {
            logger.info({ rid, eventId, userKey, data, windowMs: TAP_DEBOUNCE_MS }, "[TapGuard] duplicate postback");
            return;
        }
        if (data.startsWith("faq:")) {
            const key = decodeURIComponent(data.slice(4));
            const msgs = faqData[key] ? [createFaqAnswerFlex(key)] : [{ type: "text", text: "ただいまご案内のご用意がありませんでした。" }];
            await replyWithRetryOrPush(event, msgs);
            return;
        }
        await replyWithRetryOrPush(event, [{ type: "text", text: "ただいまご案内のご用意がありませんでした。" }]);
        return;
    }

    // text message
    if (event.type === "message" && event.message?.type === "text" && event.replyToken) {
        if (!(await tapGuardAccept(userKey, event.message.text))) {
            logger.info({ rid, eventId, userKey, text: event.message.text, windowMs: TAP_DEBOUNCE_MS }, "[TapGuard] duplicate tap");
            return;
        }
        const msgs = await routeMessage(event.message.text.trim(), event);
        if (msgs) {
            await replyWithRetryOrPush(event, msgs);
        } else {
            await replyWithRetryOrPush(event, withQuickReply(
                [{ type: "text", text: "ご質問ありがとうございます。メニューからもお選びいただけます。" }]
            ));
        }
        return;
    }

    // 未対応タイプは no-op
    logger.info({ rid, eventId, type: event.type }, "[Info] Unsupported event type -> no-op");
}

// ====== 健康チェック/疎通/メトリクス ======
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/webhook", (_req, res) => res.status(200).send("webhook ok"));
app.get("/health", async (_req, res) => {
    const mem = process.memoryUsage();
    const health = {
        ok: true,
        ts: toISO(),
        uptimeSec: Math.floor(process.uptime()),
        perKeyQueues: perKeyQueue.size,
        seenCacheSize: seenSize(),
        tapGuardSize: tapGuardSize(),
        tapWindowMs: TAP_DEBOUNCE_MS,
        rateEntries: rate.size,
        redis: !!redis,
        memory: { rssMB: +(mem.rss / 1024 / 1024).toFixed(1), heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1) },
    };
    res.status(200).json(health);
});

// /metrics に簡易 Basic 認証（環境変数 METRICS_USER/PASS の両方設定時のみ有効）
const METRICS_USER = process.env.METRICS_USER || "";
const METRICS_PASS = process.env.METRICS_PASS || "";
app.get("/metrics", async (req, res) => {
    if (METRICS_USER && METRICS_PASS) {
        const hdr = req.headers.authorization || "";
        const token = hdr.startsWith("Basic ") ? hdr.slice(6) : "";
        const [u, p] = token ? Buffer.from(token, "base64").toString().split(":") : ["", ""];
        if (u !== METRICS_USER || p !== METRICS_PASS) return res.status(401).set("WWW-Authenticate", "Basic realm=metrics").end();
    }
    res.set("Content-Type", prom.register.contentType);
    res.end(await prom.register.metrics());
});

// ====== Webhook（同期処理：全処理完了後に200） ======
app.post("/webhook", async (req, res) => {
    const rid = req.rid;
    const sig = validateSignature(req);
    if (!sig.ok) {
        logger.warn({ rid, sig }, "[WARN] Invalid signature");
        if (STRICT_SIGNATURE) return res.sendStatus(403);
        // デバッグ運用：受領した体で終了
        return res.sendStatus(200);
    }

    const endTimer = webhookHist.startTimer();
    const start = now();
    try {
        const events = Array.isArray(req.body?.events) ? req.body.events : [];
        if (events.length === 0) {
            logger.info({ rid }, "[Webhook] No events");
            endTimer();
            return res.sendStatus(200);
        }

        // 同期で逐次処理（per-keyロックで他リクエストとも直列合流）
        for (const ev of events) {
            const key = keyFromEvent(ev);
            await lockPerKeyAndRun(key, async () => processEvent(ev, rid));
        }

        endTimer();
        return res.sendStatus(200);
    } catch (e) {
        logger.error({ rid, err: e.stack || String(e) }, "[Webhook Handling Error]");
        endTimer();
        // 再送誘発したい場合は 500
        return res.sendStatus(500);
    } finally {
        logger.info({ rid, elapsed: elapsed(start) }, "[Webhook Sync Done]");
    }
});

// ====== 起動/終了 ======
const server = app.listen(PORT, () => { logger.info(`Server running at http://localhost:${PORT}`); });

function shutdown(code = 0) {
    logger.info("[Shutdown] closing server...");
    server.close(async () => {
        try { if (redis) await redis.quit(); } catch (e) { logger.warn({ e: String(e) }, "[Shutdown] redis.quit error"); }
        logger.info("[Shutdown] closed. Bye.");
        process.exit(code);
    });
    setTimeout(() => process.exit(code), 5000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
