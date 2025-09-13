const express = require("express");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== データ =====
const rabbitImages = [
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051997_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051999_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052000.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052001.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052002.jpg"
];

const faqData = {
    "駐車場": { q: "駐車場はありますか？", a: "会場には無料でご利用いただける駐車場がございます(最大78台駐車可能)\nどうぞ安心してお越しください" },
    "服装": { q: "服装の指定はありますか？", a: "平服でお越しください\n男性はスーツ、女性はセミフォーマルがおすすめです\nまた当日は屋外に出る場面もございますので肌寒く感じる場合がございます\n羽織れる服をご持参いただけますと安心です" },
    "送迎バス": { q: "送迎バスの時間を変更したい", a: "招待状で回答いただいた時間以外のバスにも乗車可能です\nご都合に合わせてご利用ください" },
    "大宮からタクシー": { q: "大宮駅からタクシー", a: "交通事情によりますが、5～10分程で到着します\n大宮駅西口よりご乗車ください" },
    "更衣室": { q: "更衣室はありますか？", a: "館内1階に個室の更衣室があります\n11:45～利用可能です" }
};

// ===== Flex生成 =====
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
                    margin: "sm"
                }))
            ]
        }
    }
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
                { type: "text", text: "A. " + faqData[key].a, wrap: true, size: "sm", margin: "md", color: "#333333" }
            ]
        }
    }
});

const createRandomRabbitImage = () => {
    const img = rabbitImages[Math.floor(Math.random() * rabbitImages.length)];
    return [{ type: "image", originalContentUrl: img, previewImageUrl: img }];
};

// ===== メッセージ判定 =====
const handleMessage = (msg) => {
    const text = msg.trim();
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
};

// ===== LINE返信処理 =====
const replyMessage = async (replyToken, messages) => {
    try {
        await axios.post(
            "https://api.line.me/v2/bot/message/reply",
            { replyToken, messages },
            {
                headers: { Authorization: `Bearer ${TOKEN}` },
                timeout: 5000 // タイムアウトを追加
            }
        );
    } catch (err) {
        console.error("LINE API error:", err.message);
    }
};

// ===== Expressルート =====
app.get("/", (_, res) => res.sendStatus(200));

app.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const events = req.body.events || [];
    await Promise.all(
        events.map(async (event) => {
            if (event.type === "message" && event.message.type === "text") {
                const messages = handleMessage(event.message.text);
                if (messages) await replyMessage(event.replyToken, messages);
            }
        })
    );
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
