// app.js - LINE Messaging API webhook 最終完全版
// - 即200返却 + setImmediate で完全非同期化（タイムアウト/遅延対策）
// - 署名検証（CHANNEL_SECRET 設定時のみ）
// - Keep-Alive で LINE API への接続確立を高速化
// - 重複配送デデュープ（webhookEventId/Redelivery）
// - 計測ログ（elapsed ms）
// - 健康チェック(/health) と 疎通確認(/webhook GET)
// - faq / FAQ:<key> / huku / test 応答

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;           // 必須：チャネルアクセストークン（長期）
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET; // 推奨：署名検証用（未設定なら検証スキップ）

// -----------------------------------------------------------------------------
// 1) 署名検証用：生ボディ保持
function rawBodySaver(req, res, buf, encoding) {
    if (buf && buf.length) req.rawBody = buf.toString(encoding || "utf8");
}
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));

// -----------------------------------------------------------------------------
// 2) 起動時チェック
console.log(`[BOOT] PORT=${PORT}`);
if (!TOKEN) console.error("[FATAL] LINE_ACCESS_TOKEN が未設定です。Environment に追加してください。");
if (!CHANNEL_SECRET) console.warn("[WARN] LINE_CHANNEL_SECRET 未設定のため、署名検証をスキップします（本番推奨設定）");

// -----------------------------------------------------------------------------
// 3) Keep-Alive 付き Axios クライアント
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const line = axios.create({
    baseURL: "https://api.line.me",
    timeout: 5000,
    headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
    },
    httpAgent: keepAliveHttpAgent,
    httpsAgent: keepAliveHttpsAgent,
});

// 計測ユーティリティ
const t0 = () => Date.now();
const dt = (t) => `${Date.now() - t}ms`;

// -----------------------------------------------------------------------------
// 4) データ
const rabbitImages = [
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051997_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051999_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052000.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052001.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052002.jpg",
];

const faqData = {
    "駐車場": { q: "駐車場はありますか？", a: "会場には無料でご利用いただける駐車場がございます(最大78台駐車可能)\nどうぞ安心してお越しください" },
    "服装": { q: "服装の指定はありますか？", a: "平服でお越しください\n男性はスーツ、女性はセミフォーマルがおすすめです\nまた当日は屋外に出る場面もございますので肌寒く感じる場合がございます\n羽織れる服をご持参いただけますと安心です" },
    "送迎バス": { q: "送迎バスの時間を変更したい", a: "招待状で回答いただいた時間以外のバスにも乗車可能です\nご都合に合わせてご利用ください" },
    "大宮からタクシー": { q: "大宮駅からタクシー", a: "交通事情によりますが、5～10分程で到着します\n大宮駅西口よりご乗車ください" },
    "更衣室": { q: "更衣室はありますか？", a: "館内1階に個室の更衣室があります\n11:45～利用可能です" },
};

// -----------------------------------------------------------------------------
// 5) Flex生成
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

// -----------------------------------------------------------------------------
// 6) メッセージ判定
function routeMessage(msg) {
    const text = (msg || "").trim();
    switch (true) {
        case /^faq$/i.test(text):
            return [createFaqListFlex()];
        case /^FAQ:/i.test(text):
            const key = text.replace(/^FAQ:/i, "").trim();
            return faqData[key] ? [createFaqAnswerFlex(key)] : [{ type: "text", text: "その質問には対応していません。" }];
        case /huku/i.test(text):
            return createRandomRabbitImage();
        case text === "test":
            return [{ type: "text", text: "Hello, user" }, { type: "text", text: "May I help you?" }];
        default:
            return null;
    }
}

// -----------------------------------------------------------------------------
// 7) 返信API（計測ログ付き）
async function replyMessage(replyToken, messages) {
    const t = t0();
    try {
        const resp = await line.post("/v2/bot/message/reply", { replyToken, messages });
        console.log("[LINE Reply] status:", resp.status, "elapsed:", dt(t));
    } catch (err) {
        if (err.response) {
            console.error("[LINE API error]", { status: err.response.status, data: err.response.data, elapsed: dt(t) });
        } else {
            console.error("[LINE API error]", err.message, "elapsed:", dt(t));
        }
    }
}

// -----------------------------------------------------------------------------
// 8) 署名検証（CHANNEL_SECRET 設定時のみ）
function validateSignature(req) {
    if (!CHANNEL_SECRET) return true;
    const signature = req.get("x-line-signature");
    if (!signature || !req.rawBody) return false;
    const hmac = crypto.createHmac("sha256", CHANNEL_SECRET);
    const digest = hmac.update(req.rawBody).digest("base64");
    return signature === digest;
}

// -----------------------------------------------------------------------------
// 9) 健康チェック/疎通
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));
app.get("/webhook", (req, res) => {
    console.log("[Webhook GET] ping at", new Date().toISOString());
    res.status(200).send("webhook ok");
});

// -----------------------------------------------------------------------------
// 10) 重複配送デデュープ
const seen = new Map(); // id -> expireAt(ms)
const SEEN_TTL = 5 * 60 * 1000; // 5分
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of seen.entries()) if (v <= now) seen.delete(k);
}, 60 * 1000);

function isDuplicate(event) {
    // webhookEventId が最優先
    const id =
        event.webhookEventId ||
        `${event.type}:${event.message?.id || ""}:${event.timestamp || ""}`;
    const now = Date.now();
    const exp = seen.get(id);
    if (exp && exp > now) return true;
    seen.set(id, now + SEEN_TTL);
    return false;
}

// -----------------------------------------------------------------------------
// 11) ログ整形
function safeLogEvent(e) {
    const base = {
        type: e.type,
        source: e.source?.type,
        msgType: e.message?.type,
        text: e.message?.text,
    };
    console.log("[Webhook Event]", JSON.stringify(base), "at", new Date().toISOString());
}

// -----------------------------------------------------------------------------
// 12) イベント処理本体
async function handleEvent(event) {
    // LINE 公式 Redelivery フラグ（true の場合は基本無視）
    if (event?.deliveryContext?.isRedelivery) {
        console.log("[Skip] Redelivery flagged by LINE");
        return;
    }
    // 追加の重複検出
    if (isDuplicate(event)) {
        console.log("[Skip] Duplicate event detected");
        return;
    }

    safeLogEvent(event);

    if (event.type === "follow" && event.replyToken) {
        await replyMessage(event.replyToken, [
            { type: "text", text: "友だち追加ありがとうございます！\n「faq」「huku」「test」を試してみてください。" },
        ]);
        return;
    }

    if (event.type === "message" && event.message?.type === "text" && event.replyToken) {
        const messages = routeMessage(event.message.text);
        if (messages) await replyMessage(event.replyToken, messages);
    }
}

// -----------------------------------------------------------------------------
// 13) Webhook（即200返却 → setImmediateで完全非同期）
app.post("/webhook", (req, res) => {
    const valid = validateSignature(req);
    if (!valid) {
        console.warn("[WARN] Invalid or missing signature (skip processing, return 200)");
        return res.sendStatus(200); // タイムアウト回避を優先（安定後は403に戻してOK）
    }

    // まず最優先で 200 を返す（LINE側のタイムアウト回避）
    res.sendStatus(200);

    // レスポンス返却後に完全非同期で処理
    setImmediate(async () => {
        try {
            const events = Array.isArray(req.body?.events) ? req.body.events : [];
            if (events.length === 0) {
                console.log("[Webhook] No events");
                return;
            }
            await Promise.all(events.map(handleEvent));
        } catch (e) {
            console.error("[Webhook Handling Error]", e?.message || e);
        }
    });
});

// -----------------------------------------------------------------------------
// 14) 起動
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
