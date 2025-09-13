// app.js - LINE Messaging API webhook（高耐久・最終完全版）
// - 即200返却 + setImmediate で完全非同期
// - 署名検証（STRICT_SIGNATUREで403切替可）
// - Keep-Alive高速化（調整済）
// - 重複配送デデュープ（webhookEventId/Redelivery）
// - 429/5xx リトライ（指数バックオフ＋Retry-After）
// - ユーザー/グループ逐次処理 + グローバル同時実行制限（未捕捉例外でチェーンが切れない）
// - 構造化ログ（相関ID, elapsed ms）
// - 健康チェック(/health), 疎通(/webhook GET)
// - 既存応答：faq / FAQ:<key> / huku / test

"use strict";

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const app = express();

// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;               // 必須
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;     // 推奨
const STRICT_SIGNATURE = /^true$/i.test(process.env.STRICT_SIGNATURE || "false"); // trueで無効署名を403
const GLOBAL_MAX_CONCURRENCY = Number(process.env.GLOBAL_MAX_CONCURRENCY || 10);
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 5000);

// ====== 生ボディ保持（署名検証用） ======
function rawBodySaver(req, res, buf, encoding) {
    if (buf && buf.length) req.rawBody = buf.toString(encoding || "utf8");
}
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));

// ====== 起動ログ ======
console.log(`[BOOT] PORT=${PORT}`);
if (!TOKEN) console.error("[FATAL] LINE_ACCESS_TOKEN 未設定");
if (!CHANNEL_SECRET) console.warn("[WARN] LINE_CHANNEL_SECRET 未設定（署名検証スキップ可）");
if (STRICT_SIGNATURE) console.log("[BOOT] STRICT_SIGNATURE=ON （無効署名は403）");

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

// ====== 計測ユーティリティ ======
const now = () => Date.now();
const elapsed = (t) => `${Date.now() - t}ms`;
const toISO = (d = new Date()) => d.toISOString();

// ====== データ ======
const rabbitImages = [
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051997_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051999_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052000.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052001.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052002.jpg",
];

const faqData = {
    "駐車場": { q: "駐車場はありますか？", a: "会場には無料でご利用いただける駐車場がございます(最大78台)\nどうぞ安心してお越しください" },
    "服装": { q: "服装の指定はありますか？", a: "平服でお越しください\n男性はスーツ、女性はセミフォーマルがおすすめです\n屋外に出る場面もあるため羽織れる服が安心です" },
    "送迎バス": { q: "送迎バスの時間を変更したい", a: "招待状で回答以外の便にも乗車可能です\nご都合に合わせてご利用ください" },
    "大宮からタクシー": { q: "大宮駅からタクシー", a: "5～10分程で到着します（交通事情による）\n西口よりご乗車ください" },
    "更衣室": { q: "更衣室はありますか？", a: "館内1階に個室の更衣室があります\n11:45～利用可能です" },
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
    altText: faqData[key].q,
    contents: {
        type: "bubble",
        styles: { body: { backgroundColor: "#FFFAF0" } },
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                { type: "text", text: "Q. " + faqData[key].q, weight: "bold", size: "md", color: "#C19A6B" },
                { type: "text", text: "A. " + faqData[key].a, wrap: true, size: "sm", margin: "md", color: "#333333" },
            ],
        },
    },
});

const createRandomRabbitImage = () => {
    const img = rabbitImages[Math.floor(Math.random() * rabbitImages.length)];
    return [{ type: "image", originalContentUrl: img, previewImageUrl: img }];
};

// ====== ルーティング ======
function routeMessage(msg) {
    const textRaw = (msg || "");
    const text = textRaw.trim();
    const lc = text.toLowerCase();

    if (lc === "faq") return [createFaqListFlex()];

    if (lc.startsWith("faq:")) {
        const key = text.replace(/^faq:/i, "").trim();
        return faqData[key] ? [createFaqAnswerFlex(key)] : [{ type: "text", text: "その質問には対応していません。" }];
    }

    if (/(\bhuku\b)/i.test(text)) {
        return createRandomRabbitImage();
    }

    if (lc === "test") {
        return [{ type: "text", text: "Hello, user" }, { type: "text", text: "May I help you?" }];
    }

    return null;
}

// ====== 署名検証 ======
function validateSignature(req) {
    if (!CHANNEL_SECRET) return { ok: true, reason: "no-secret" };
    const signature = req.get("x-line-signature");
    if (!signature || !req.rawBody) return { ok: false, reason: "missing" };
    const digest = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
    const ok = signature === digest; // シンプル比較（十分）
    return { ok, reason: ok ? "match" : "mismatch" };
}

// ====== 返信（リトライ付） ======
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
        console.warn("[Reply Skip]", { eventId, reason: "no-messages" });
        return;
    }

    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const resp = await line.post("/v2/bot/message/reply", { replyToken, messages });
            console.log("[LINE Reply]", {
                eventId, status: resp.status, attempt, elapsed: elapsed(start), size: messages.length,
            });
            return; // 成功したら即終了（replyTokenは1回限り）
        } catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            const retryAfterSec = parseInt(err.response?.headers?.["retry-after"] || "0", 10);
            console.error("[LINE API error]", {
                eventId, attempt, status, data, elapsed: elapsed(start),
            });

            // 429/5xxのみリトライ
            if (status === 429 || (status >= 500 && status < 600)) {
                const backoff = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(2000 * Math.pow(2, attempt - 1), 8000);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            // 4xx（失効等）は即断念
            return;
        }
    }
}

// ====== デデュープ（再配送/重複ID） ======
const seen = new Map(); // id -> expireAt
const SEEN_TTL = 5 * 60 * 1000; // 5分
setInterval(() => {
    const t = now();
    for (const [k, v] of seen.entries()) if (v <= t) seen.delete(k);
}, 60 * 1000);

function eventKey(e) {
    // webhookEventId が最優先（公式一意）
    if (e.webhookEventId) return `id:${e.webhookEventId}`;
    // フォールバック（完全ではないが保険）
    return `${e.type}:${e.message?.id || ""}:${e.timestamp || ""}`;
}

function isDuplicate(event) {
    const key = eventKey(event);
    const t = now();
    const exp = seen.get(key);
    if (exp && exp > t) return true;
    seen.set(key, t + SEEN_TTL);
    return false;
}

// ====== ログ整形 ======
function safeLogEvent(e) {
    const base = {
        eventId: e.webhookEventId || null,
        type: e.type,
        source: e.source?.type,
        msgType: e.message?.type,
        text: e.message?.text,
    };
    console.log("[Webhook Event]", JSON.stringify(base), "at", toISO());
}

// ====== キュー制御（ユーザー/グループ逐次 + グローバル同時実行制限） ======
const perKeyQueue = new Map(); // key -> Promise chain
let globalRunning = 0;
const globalQueue = []; // [fn]

function keyFromEvent(e) {
    if (e.source?.type === "user") return `user:${e.source.userId || "unknown"}`;
    if (e.source?.type === "group") return `group:${e.source.groupId || "unknown"}`;
    if (e.source?.type === "room") return `room:${e.source.roomId || "unknown"}`;
    return "unknown";
}

function scheduleGlobal(fn) {
    return new Promise((resolve) => {
        const run = async () => {
            globalRunning++;
            try {
                const res = await fn();
                resolve(res);
            } catch (e) {
                // ここで必ず握り潰す（上位にrejectを伝播させない）
                console.error("[Task Error]", e?.stack || e);
                resolve(undefined);
            } finally {
                globalRunning--;
                const next = globalQueue.shift();
                if (next) next();
            }
        };
        if (globalRunning < GLOBAL_MAX_CONCURRENCY) run();
        else globalQueue.push(run);
    });
}

function enqueuePerKey(key, taskFn) {
    const prev = perKeyQueue.get(key) || Promise.resolve();
    const run = () => scheduleGlobal(taskFn); // ここでcatchしてresolve済みになる

    // 前段の成功/失敗を問わず run を実行し、常にresolveするチェーンを構築
    const next = prev.then(run, run);

    perKeyQueue.set(key, next.finally(() => {
        if (perKeyQueue.get(key) === next) perKeyQueue.delete(key);
    }));
}

// ====== イベント処理 ======
async function processEvent(event) {
    const eventId = event.webhookEventId || "no-id";

    if (event?.deliveryContext?.isRedelivery) {
        console.log("[Skip] Redelivery", { eventId });
        return;
    }
    if (isDuplicate(event)) {
        console.log("[Skip] Duplicate", { eventId });
        return;
    }

    safeLogEvent(event);

    // フォロー時のウェルカム
    if (event.type === "follow" && event.replyToken) {
        await replyWithRetry(eventId, event.replyToken, [
            { type: "text", text: "友だち追加ありがとうございます！\n「faq」「huku」「test」を試してみてください。" },
        ]);
        return;
    }

    // テキストメッセージ
    if (event.type === "message" && event.message?.type === "text" && event.replyToken) {
        const msgs = routeMessage(event.message.text);
        await replyWithRetry(eventId, event.replyToken, msgs || [{ type: "text", text: "ご質問ありがとうございます。" }]);
        return;
    }

    // 未対応タイプは無視（将来拡張用）
    console.log("[Info] Unsupported event type handled as no-op", { eventId, type: event.type });
}

// ====== 健康チェック/疎通 ======
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/webhook", (_, res) => res.status(200).send("webhook ok"));
app.get("/health", (_, res) => {
    res.status(200).json({
        ok: true,
        ts: toISO(),
        uptimeSec: Math.floor(process.uptime()),
        global: { running: globalRunning, queued: globalQueue.length, max: GLOBAL_MAX_CONCURRENCY },
        perKeyQueues: perKeyQueue.size,
        seenCacheSize: seen.size,
    });
});

// ====== Webhook（即200→完全非同期） ======
app.post("/webhook", (req, res) => {
    const sig = validateSignature(req);
    if (!sig.ok) {
        console.warn("[WARN] Invalid signature", sig);
        if (STRICT_SIGNATURE) return res.sendStatus(403);
        // デバッグ運用：200で受領した体で処理スキップ
        res.sendStatus(200);
        return;
    }

    // 先に200を返し、処理は完全非同期で
    res.sendStatus(200);

    setImmediate(async () => {
        const start = now();
        try {
            const events = Array.isArray(req.body?.events) ? req.body.events : [];
            if (events.length === 0) {
                console.log("[Webhook] No events", { elapsed: elapsed(start) });
                return;
            }

            for (const ev of events) {
                const key = keyFromEvent(ev);
                const tag = { key, eventId: ev.webhookEventId || "no-id" };
                enqueuePerKey(key, () => processEvent(ev));
                console.log("[Enqueued]", tag);
            }
        } catch (e) {
            console.error("[Webhook Handling Error]", e?.stack || e);
        } finally {
            console.log("[Webhook Dispatch Done]", { elapsed: elapsed(start) });
        }
    });
});

// ====== 起動/終了 ======
const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

function shutdown(code = 0) {
    console.log("[Shutdown] closing server...");
    server.close(() => {
        console.log("[Shutdown] closed. Bye.");
        process.exit(code);
    });
    // 5秒で強制終了
    setTimeout(() => process.exit(code), 5000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
