// app.js - LINE Messaging API webhook（同期処理・ダブルタップ抑止・最終完全版）
// - 同期処理：1リクエスト内で逐次処理→完了後に200返却
// - 同一ユーザー/グループで直列化（リクエストをまたいでも順序保証）
// - ダブルタップ抑止（サーバ側デバウンス：同一ペイロードを一定時間1回に制限）
// - 署名検証（STRICT_SIGNATURE=true で無効署名は403）
// - Keep-Alive（LINE API接続高速化）
// - 重複配送デデュープ（webhookEventId/Redelivery）
// - 429/5xx リトライ（指数バックオフ＋Retry-After）
// - 構造化ログ（相関ID, elapsed ms）
// - 健康チェック(/health)・疎通(/webhook GET)
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
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 5000);
// ダブルタップ抑止（同一ユーザー/グループ×同一ペイロードを一定時間だけ1回許可）
const TAP_DEBOUNCE_MS = Number(process.env.TAP_DEBOUNCE_MS || 1200);

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

// ====== メッセージ生成（※ボタンは message アクションのまま。postback対応もサーバ側で用意） ======
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
    const ok = signature === digest;
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

            if (status === 429 || (status >= 500 && status < 600)) {
                const backoff = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(2000 * Math.pow(2, attempt - 1), 8000);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            return; // 4xx（失効等）は即断念
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
    if (e.webhookEventId) return `id:${e.webhookEventId}`;
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

// ====== ダブルタップ抑止（サーバ側デバウンス） ======
const tapGuards = new Map(); // mapKey -> expireAt
const TAP_GUARD_SWEEP_MS = 60 * 1000;
setInterval(() => {
    const t = Date.now();
    for (const [k, exp] of tapGuards.entries()) if (exp <= t) tapGuards.delete(k);
}, TAP_GUARD_SWEEP_MS);

function normalizePayloadText(s) {
    return String(s || "").trim().toLowerCase();
}

function tapGuardAccept(userOrGroupKey, payloadText) {
    const norm = normalizePayloadText(payloadText);
    const mapKey = `${userOrGroupKey}|${norm}`;
    const t = Date.now();
    const exp = tapGuards.get(mapKey);
    if (exp && exp > t) {
        return false; // デバウンス期間内は拒否
    }
    tapGuards.set(mapKey, t + TAP_DEBOUNCE_MS);
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

    // follow
    if (event.type === "follow" && event.replyToken) {
        await replyWithRetry(eventId, event.replyToken, [
            { type: "text", text: "友だち追加ありがとうございます！\n「faq」「huku」「test」を試してみてください。" },
        ]);
        return;
    }

    // postback（将来ボタンをpostback化しても動作）
    if (event.type === "postback" && event.replyToken) {
        const userKey = keyFromEvent(event);
        const data = String(event.postback?.data || "");
        if (!tapGuardAccept(userKey, data)) {
            console.log("[TapGuard] Ignored duplicate postback", { eventId, userKey, data, windowMs: TAP_DEBOUNCE_MS });
            return;
        }

        if (data.startsWith("faq:")) {
            const key = decodeURIComponent(data.slice(4));
            const msgs = faqData[key] ? [createFaqAnswerFlex(key)] : [{ type: "text", text: "その質問には対応していません。" }];
            await replyWithRetry(eventId, event.replyToken, msgs);
            return;
        }

        // その他のpostbackコマンドはここに追加
        return;
    }

    // text message
    if (event.type === "message" && event.message?.type === "text" && event.replyToken) {
        const userKey = keyFromEvent(event);
        // “FAQ:xxx / huku / test / faq” 等をデバウンス
        if (!tapGuardAccept(userKey, event.message.text)) {
            console.log("[TapGuard] Ignored duplicate tap within window", {
                eventId, userKey, text: event.message.text, windowMs: TAP_DEBOUNCE_MS
            });
            return;
        }
        const msgs = routeMessage(event.message.text);
        await replyWithRetry(eventId, event.replyToken, msgs || [{ type: "text", text: "ご質問ありがとうございます。" }]);
        return;
    }

    // 未対応タイプはno-op
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
        perKeyQueues: perKeyQueue.size,
        seenCacheSize: seen.size,
        tapGuardSize: tapGuards.size,
        tapWindowMs: TAP_DEBOUNCE_MS,
    });
});

// ====== Webhook（同期処理：全処理完了後に200） ======
app.post("/webhook", async (req, res) => {
    const sig = validateSignature(req);
    if (!sig.ok) {
        console.warn("[WARN] Invalid signature", sig);
        if (STRICT_SIGNATURE) return res.sendStatus(403);
        return res.sendStatus(200); // デバッグ運用：受領した体で終了
    }

    const start = now();
    try {
        const events = Array.isArray(req.body?.events) ? req.body.events : [];
        if (events.length === 0) {
            console.log("[Webhook] No events");
            return res.sendStatus(200);
        }

        // 同期で逐次処理（ここでawait）
        for (const ev of events) {
            const key = keyFromEvent(ev);
            await lockPerKeyAndRun(key, async () => processEvent(ev));
        }

        return res.sendStatus(200);
    } catch (e) {
        console.error("[Webhook Handling Error]", e?.stack || e);
        // 運用方針に応じて500/200を選択（ここでは500で再送誘発）
        return res.sendStatus(500);
    } finally {
        console.log("[Webhook Sync Done]", { elapsed: elapsed(start) });
    }
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
    setTimeout(() => process.exit(code), 5000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
