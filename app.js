// app.js - LINE Messaging API webhook 最終完全版
// 特徴:
// - コールドスタート対策のため Webhook へは "最初に即200" を返却（処理は非同期で継続）
// - CHANNEL_SECRET 設定時は署名検証を実施（未設定ならスキップ）
// - faq / FAQ:<key> / huku / test に応答（Flex/画像/テキスト）
// - 健康チェック(/health)と疎通確認(/webhook GET)
// - 詳細ログ（返信APIの status/data、受信イベントの要約）
// - Render等のPaaSで PORT 自動対応

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;         // 必須：チャネルアクセストークン（長期）
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET; // 推奨：署名検証用

// -----------------------------------------------------------------------------
// 1) 署名検証用の生ボディ保持
function rawBodySaver(req, res, buf, encoding) {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || "utf8");
    }
}
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));

// -----------------------------------------------------------------------------
// 2) 起動時チェック
console.log(`[BOOT] PORT=${PORT}`);
if (!TOKEN) {
    console.error("[FATAL] LINE_ACCESS_TOKEN が未設定です。Render の Environment に追加してください。");
}
if (!CHANNEL_SECRET) {
    console.warn("[WARN] LINE_CHANNEL_SECRET が未設定のため、署名検証をスキップします（本番は設定推奨）");
}

// -----------------------------------------------------------------------------
// 3) データ
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
// 4) Flex生成
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
// 5) メッセージ判定
function handleMessage(msg) {
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
// 6) 返信API
async function replyMessage(replyToken, messages) {
    try {
        const resp = await axios.post(
            "https://api.line.me/v2/bot/message/reply",
            { replyToken, messages },
            {
                headers: {
                    "Authorization": `Bearer ${TOKEN}`,
                    "Content-Type": "application/json",
                },
                timeout: 8000,
            }
        );
        console.log("[LINE Reply] status:", resp.status);
    } catch (err) {
        if (err.response) {
            console.error("[LINE API error]", { status: err.response.status, data: err.response.data });
        } else {
            console.error("[LINE API error]", err.message);
        }
    }
}

// -----------------------------------------------------------------------------
// 7) 署名検証（CHANNEL_SECRET 設定時のみ有効）
function validateSignature(req) {
    if (!CHANNEL_SECRET) return true; // 未設定なら検証スキップ
    const signature = req.get("x-line-signature");
    if (!signature || !req.rawBody) return false;
    const hmac = crypto.createHmac("sha256", CHANNEL_SECRET);
    const digest = hmac.update(req.rawBody).digest("base64");
    return signature === digest;
}

// -----------------------------------------------------------------------------
// 8) 健康チェック/疎通確認
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));
app.get("/webhook", (req, res) => {
    console.log("[Webhook GET] ping");
    res.status(200).send("webhook ok");
});

// -----------------------------------------------------------------------------
// 9) Webhook 本体（最初に必ず 200 を返す設計）
function safeLogEvent(e) {
    const base = {
        type: e.type,
        source: e.source?.type,
        msgType: e.message?.type,
        text: e.message?.text,
    };
    console.log("[Webhook Event]", JSON.stringify(base));
}

app.post("/webhook", async (req, res) => {
    // まず即時 200 を返して LINE 側タイムアウトを回避
    // （署名不正時は処理スキップだが 200 を返す運用。安定後は 403 に戻してOK）
    const valid = validateSignature(req);
    if (!valid) {
        console.warn("[WARN] Invalid or missing signature (skip processing, return 200)");
        return res.sendStatus(200);
    }
    res.sendStatus(200);

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (events.length === 0) {
        console.log("[Webhook] No events");
        return;
    }

    await Promise.all(
        events.map(async (event) => {
            try {
                safeLogEvent(event);

                // 友だち追加時の案内
                if (event.type === "follow" && event.replyToken) {
                    await replyMessage(event.replyToken, [
                        { type: "text", text: "友だち追加ありがとうございます！\n「faq」「huku」「test」を試してみてください。" },
                    ]);
                    return;
                }

                // テキストメッセージに応答
                if (event.type === "message" && event.message?.type === "text" && event.replyToken) {
                    const messages = handleMessage(event.message.text);
                    if (messages) await replyMessage(event.replyToken, messages);
                }
            } catch (e) {
                console.error("[Webhook Handling Error]", e?.message || e);
            }
        })
    );
});

// -----------------------------------------------------------------------------
// 10) 起動
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
