// app.js - LINE Messaging API webhook（同期処理・分散タップ抑止・完全版／祝席向け文面）
// 機能一覧：
// - 同期処理：1リクエスト内で逐次処理→完了後に200返却
// - 同一ユーザー/グループで直列化（リクエスト跨ぎでも順序保証）
// - ダブルタップ抑止（デバウンス：同一ペイロード一定時間1回・Redis対応）
// - 重複配送デデュープ（webhookEventId優先・Redis対応）
// - 署名検証（STRICT_SIGNATURE=true で無効署名は403）
// - Keep-Alive（LINE API接続高速化）
// - 429/5xx リトライ（指数バックオフ＋Retry-After）
// - reply 失敗時の Push 代替（ユーザー宛のみ）
// - 構造化ログ（pino）＋相関ID（x-request-id）
// - Prometheusメトリクス（/metrics） ヒストグラム/カウンタ
// - ユーザー単位レート制限（簡易トークンバケット）
// - ルーター方式コマンド（拡張容易）＋Quick Reply
// - 管理者ステータスコマンド（admin:stats）
// - 健康チェック(/health)・疎通(/webhook GET)
// - 祝席向け：フォロー時の挨拶＆未定義コマンド応答を縁起よく配慮
"use strict";

const express = require("express");
const axios = require("axios");
const { randomUUID, createHmac } = require("crypto");
const http = require("http");
const https = require("https");
const pino = require("pino");
const Redis = require("ioredis");
const client = require("prom-client"); // Prometheus

const app = express();

// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;               // 必須
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;     // 推奨
const STRICT_SIGNATURE = /^true$/i.test(process.env.STRICT_SIGNATURE || "false"); // trueで無効署名403
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 5000);

// デバウンス（タップガード）とデデュープのTTL
const TAP_DEBOUNCE_MS = Number(process.env.TAP_DEBOUNCE_MS || 1200);
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 5 * 60 * 1000);

// レート制限（ユーザー単位トークンバケット）
const RATE_CAP = Number(process.env.RATE_CAP || 10); // バースト上限
const RATE_REFILL = Number(process.env.RATE_REFILL || 1); // 1秒あたり回復数

// 管理者（admin:stats 実行許可）
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

// Redis（任意）: 指定時はタップガード/デデュープを分散実装
const REDIS_URL = process.env.REDIS_URL || "";
let redis = null;
if (REDIS_URL) {
    redis = new Redis(REDIS_URL);
}

// ====== ロガー ======
const logger = pino(
    process.env.NODE_ENV === "production"
        ? {}
        : { transport: { target: "pino-pretty" } }
);

// ====== 生ボディ保持（署名検証用） ======
function rawBodySaver(req, res, buf, encoding) {
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
        logger.info({
            rid, method: req.method, url: req.originalUrl, status: res.statusCode,
            elapsedMs: Date.now() - start
        }, "HTTP finished");
    });
    next();
});

// ====== 起動ログ ======
logger.info({ PORT }, "[BOOT] starting");
if (!TOKEN) logger.error("[FATAL] LINE_ACCESS_TOKEN 未設定");
if (!CHANNEL_SECRET) logger.warn("[WARN] LINE_CHANNEL_SECRET 未設定（署名検証スキップ可）");
if (STRICT_SIGNATURE) logger.info("[BOOT] STRICT_SIGNATURE=ON （無効署名は403）");
if (redis) logger.info({ REDIS_URL }, "[BOOT] Redis enabled for dedupe/tapGuard");
else logger.warn("[BOOT] Redis disabled, will use in-memory for dedupe/tapGuard");

// ====== Keep-Alive Axios（LINE API用） ======
const keepAliveHttpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 10_000,
    maxSockets: 100,
    maxFreeSockets: 20,
});
const keepAliveHttpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10_000,
    maxSockets: 100,
    maxFreeSockets: 20,
});
const line = axios.create({
    baseURL: "https://api.line.me",
    timeout: AXIOS_TIMEOUT_MS,
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    httpAgent: keepAliveHttpAgent,
    httpsAgent: keepAliveHttpsAgent,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
});

// ====== Prometheus メトリクス ======
client.collectDefaultMetrics();
const webhookHist = new client.Histogram({
    name: "line_webhook_duration_seconds",
    help: "Webhook processing time",
    buckets: [0.1, 0.3, 0.5, 1, 2, 5, 10],
});
const replyCounter = new client.Counter({
    name: "line_reply_messages_total",
    help: "Total messages replied",
});
const rateLimitBlockCounter = new client.Counter({
    name: "line_ratelimit_block_total",
    help: "Rate limit blocks",
});
const tapGuardBlockCounter = new client.Counter({
    name: "line_tapguard_block_total",
    help: "Tap guard (debounce) blocks",
});

// ====== 計測ユーティリティ ======
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

// Quick Reply ヘルパ
function withQuickReply(messages, items = []) {
    const quickReply = {
        items: items.map(i => ({ type: "action", action: { type: "message", label: i.label, text: i.text } }))
    };
    const compact = sanitizeMessages(messages);
    if (compact.length === 0) return compact;
    const [head, ...rest] = compact;
    return [{ ...head, quickReply }, ...rest];
}

// ====== ルーター（拡張容易） ======
const routes = [
    {
        match: /^admin:stats$/i,
        handle: (text, m, event) => {
            if (event.source?.type === "user" && ADMIN_USER_IDS.includes(event.source.userId)) {
                const body = [
                    `uptimeSec: ${Math.floor(process.uptime())}`,
                    `perKeyQueues: ${perKeyQueue.size}`,
                    `seenCacheSize: ${seenSize()}`,
                    `tapGuardSize: ${tapGuardSize()}`,
                    `rateEntries: ${rate.size}`
                ].join("\n");
                return [{ type: "text", text: body }];
            }
            return [{ type: "text", text: "権限対象ではございません。" }];
        }
    },
    { match: /^faq$/i, handle: () => [createFaqListFlex()] },
    {
        match: /^faq:(.+)$/i,
        handle: (_, m) => {
            const key = m[1].trim();
            return faqData[key] ? [createFaqAnswerFlex(key)] : [{ type: "text", text: "ただいまご案内のご用意がありませんでした。" }];
        }
    },
    { match: /\bhuku\b/i, handle: () => createRandomRabbitImage() },
    { match: /^test$/i, handle: () => [{ type: "text", text: "Hello, user" }, { type: "text", text: "May I help you?" }] },
];

function routeMessage2(text, event) {
    for (const r of routes) {
        const m = text.match(r.match);
        if (m) return r.handle(text, m, event);
    }
    return null;
}

// ====== 署名検証 ======
function validateSignature(req) {
    if (!CHANNEL_SECRET) return { ok: true, reason: "no-secret" };
    const signature = req.get("x-line-signature");
    if (!signature || !req.rawBody) return { ok: false, reason: "missing" };
    const digest = createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
    const ok = signature === digest;
    return { ok, reason: ok ? "match" : "mismatch" };
}

// ====== 返信（リトライ付）＋Pushフォールバック ======
const MAX_REPLY_MESSAGES = 5;

function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const compact = messages.filter(Boolean);
    return compact.slice(0, MAX_REPLY_MESSAGES);
}

async function replyWithRetry(eventId, replyToken, rawMessages) {
    const start = now();
    const messages = sanitizeMessages(rawMessages);
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
            return; // 成功したら終了
        } catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            const retryAfterSec = parseInt(err.response?.headers?.["retry-after"] || "0", 10);
            logger.error({ eventId, attempt, status, data, elapsed: elapsed(start) }, "LINE Reply error");

            if (status === 429 || (status >= 500 && status < 600)) {
                const backoff = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(2000 * Math.pow(2, attempt - 1), 8000);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            throw err; // 4xxは上に投げる（フォールバック判断用）
        }
    }
}

async function pushMessage(to, rawMessages) {
    const messages = sanitizeMessages(rawMessages);
    await line.post("/v2/bot/message/push", { to, messages });
    replyCounter.inc(messages.length);
}

async function replyWithRetryOrPush(event, rawMessages) {
    const eventId = event.webhookEventId || "no-id";
    try {
        await replyWithRetry(eventId, event.replyToken, rawMessages);
    } catch (e) {
        const status = e.response?.status;
        if ((status >= 400 && status < 500) && event.source?.type === "user" && event.source.userId) {
            logger.warn({ eventId, status }, "Reply failed -> Push fallback");
            await pushMessage(event.source.userId, rawMessages);
        } else {
            throw e;
        }
    }
}

// ====== デデュープ（再配送/重複ID） ======
const seenMem = new Map(); // id -> expireAt（メモリ用）
setInterval(() => {
    if (redis) return;
    const t = now();
    for (const [k, v] of seenMem.entries()) if (v <= t) seenMem.delete(k);
}, 60 * 1000);

function eventKey(e) {
    if (e.webhookEventId) return `id:${e.webhookEventId}`;
    return `${e.type}:${e.message?.id || ""}:${e.timestamp || ""}`;
}

async function isDuplicate(event) {
    const key = eventKey(event);
    const t = now();
    if (redis) {
        // SET PX TTL NX -> if OK, first seen; else duplicate
        const ok = await redis.set(`dedupe:${key}`, "1", "PX", DEDUPE_TTL_MS, "NX");
        return ok !== "OK";
    } else {
        const exp = seenMem.get(key);
        if (exp && exp > t) return true;
        seenMem.set(key, t + DEDUPE_TTL_MS);
        return false;
    }
}
function seenSize() {
    return redis ? -1 : seenMem.size; // Redis時は不明のため -1
}

// ====== ログ整形 ======
function safeLogEvent(e, rid) {
    const base = {
        rid,
        eventId: e.webhookEventId || null,
        type: e.type,
        source: e.source?.type,
        msgType: e.message?.type,
        text: e.message?.text,
    };
    logger.info(base, "[Webhook Event]");
}

// ====== ダブルタップ抑止（タップガード：Redis or メモリ） ======
const tapMem = new Map(); // mapKey -> expireAt（メモリ用）
setInterval(() => {
    if (redis) return;
    const t = Date.now();
    for (const [k, exp] of tapMem.entries()) if (exp <= t) tapMem.delete(k);
}, 60 * 1000);

function normalizePayloadText(s) {
    return String(s || "").trim().toLowerCase();
}

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
        if (exp && exp > t) {
            tapGuardBlockCounter.inc();
            return false;
        }
        tapMem.set(mapKey, t + TAP_DEBOUNCE_MS);
        return true;
    }
}
function tapGuardSize() {
    return redis ? -1 : tapMem.size;
}

// ====== レート制限（ユーザー単位 簡易トークンバケット） ======
const rate = new Map(); // key -> { tokens, updatedAtSec }
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
        .finally(() => {
            if (perKeyQueue.get(key) === run) perKeyQueue.delete(key);
        });

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

    // postback（ボタンpostback化を想定）
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

        // その他のpostbackコマンド
        await replyWithRetryOrPush(event, [
            { type: "text", text: "ただいまご案内のご用意がありませんでした。" }
        ]);
        return;
    }

    // text message
    if (event.type === "message" && event.message?.type === "text" && event.replyToken) {
        if (!(await tapGuardAccept(userKey, event.message.text))) {
            logger.info({ rid, eventId, userKey, text: event.message.text, windowMs: TAP_DEBOUNCE_MS }, "[TapGuard] duplicate tap");
            return;
        }

        const msgs = routeMessage2(event.message.text.trim(), event);
        if (msgs) {
            await replyWithRetryOrPush(event, msgs);
        } else {
            await replyWithRetryOrPush(event, withQuickReply(
                [{ type: "text", text: "ご質問ありがとうございます\nこちらのチャットでは自動返信に対応していません\nメニューから選択をお願いします" }]
            ));
        }
        return;
    }

    // 未対応タイプはno-op（ユーザーには出さない）
    logger.info({ rid, eventId, type: event.type }, "[Info] Unsupported event type -> no-op");
}

// ====== 健康チェック/疎通/メトリクス ======
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/webhook", (_, res) => res.status(200).send("webhook ok"));
app.get("/health", (_, res) => {
    res.status(200).json({
        ok: true,
        ts: toISO(),
        uptimeSec: Math.floor(process.uptime()),
        perKeyQueues: perKeyQueue.size,
        seenCacheSize: seenSize(),
        tapGuardSize: tapGuardSize(),
        tapWindowMs: TAP_DEBOUNCE_MS,
        rateEntries: rate.size,
        redis: !!redis,
    });
});
app.get("/metrics", async (_, res) => {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
});

// ====== Webhook（同期処理：全処理完了後に200） ======
app.post("/webhook", async (req, res) => {
    const rid = req.rid;
    const sig = validateSignature(req);
    if (!sig.ok) {
        logger.warn({ rid, sig }, "[WARN] Invalid signature");
        if (STRICT_SIGNATURE) return res.sendStatus(403);
        return res.sendStatus(200); // デバッグ運用：受領した体で終了
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
        logger.error({ rid, err: e.stack || e }, "[Webhook Handling Error]");
        endTimer();
        // 再送誘発したい場合は500
        return res.sendStatus(500);
    } finally {
        logger.info({ rid, elapsed: elapsed(start) }, "[Webhook Sync Done]");
    }
});

// ====== 起動/終了 ======
const server = app.listen(PORT, () => {
    logger.info(`Server running at http://localhost:${PORT}`);
});

function shutdown(code = 0) {
    logger.info("[Shutdown] closing server...");
    server.close(() => {
        logger.info("[Shutdown] closed. Bye.");
        process.exit(code);
    });
    setTimeout(() => process.exit(code), 5000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
