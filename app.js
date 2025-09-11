const https = require("https");
const express = require("express");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;
const app = express();

// 画像URLリスト
const rabbitImages = [
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051997_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051999_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052000.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052001.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052002.jpg"
];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// FAQデータ
const faqData = {
    "駐車場": { q: "駐車場はありますか？", a: "会場専用の駐車場をご利用いただけます。満車の場合は近隣のコインパーキングをご案内いたします。" },
    "服装": { q: "服装の指定はありますか？", a: "平服でお越しください。男性はスーツ、女性はセミフォーマルがおすすめです。白いドレスは花嫁と重なるためご遠慮ください。" },
    "ご祝儀": { q: "ご祝儀はどうすればいいですか？", a: "受付にてお渡しください。袱紗に包んでご持参いただけると丁寧です。" },
    "受付時間": { q: "受付は何時から始まりますか？", a: "挙式の30分前から受付を開始いたします。混雑が予想されますのでお早めにお越しください。" },
    "写真撮影": { q: "写真撮影はしてもいいですか？", a: "挙式中はご遠慮いただき、披露宴中は自由に撮影いただけます。SNS投稿の際は新郎新婦にご確認ください。" }
};

// ===== FAQ関連関数 =====
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
                // FAQタイトル：白いハトアイコンに変更
                { type: "text", text: "🕊️ 結婚式 FAQ", weight: "bold", size: "lg", align: "center", color: "#C19A6B" },
                { type: "separator", margin: "md", color: "#E6C9C9" },
                ...Object.keys(faqData).map((key, i) => ({
                    type: "button",
                    style: "primary",
                    color: ["#FADADD", "#D5E8D4", "#DDEBF7"][i % 3],
                    action: { type: "message", label: faqData[key].q, text: "FAQ:" + key },
                    margin: "sm",
                    // ボタン文字色を黒に指定
                    color: "#000000"
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

// ===== HUKU（画像）関連関数 =====
const createRandomRabbitImage = () => {
    const randomImage = rabbitImages[Math.floor(Math.random() * rabbitImages.length)];
    return [{ type: "image", originalContentUrl: randomImage, previewImageUrl: randomImage }];
};

// ===== メッセージ処理関数 =====
const handleMessage = (userMessage) => {
    userMessage = userMessage.trim();
    if (/^faq$/i.test(userMessage)) return [createFaqListFlex()];
    if (/^FAQ:/i.test(userMessage)) {
        const key = userMessage.replace(/^FAQ:/i, "").trim();
        return faqData[key] ? [createFaqAnswerFlex(key)] : [{ type: "text", text: "その質問には対応していません。" }];
    }
    if (/huku/i.test(userMessage)) return createRandomRabbitImage();
    if (userMessage === "test") return [{ type: "text", text: "Hello, user" }, { type: "text", text: "May I help you?" }];
    return null;
};

// ===== Expressルート =====
app.get("/", (_, res) => res.sendStatus(200));

app.post("/webhook", (req, res) => {
    res.status(200).end();
    const events = req.body.events || [];

    events.forEach(event => {
        if (event.type === "message" && event.message.type === "text") {
            const messages = handleMessage(event.message.text);
            if (!messages) return console.log("No reply sent.");

            const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN };
            const dataString = JSON.stringify({ replyToken: event.replyToken, messages });

            const webhookOptions = { hostname: "api.line.me", path: "/v2/bot/message/reply", method: "POST", headers };

            const request = https.request(webhookOptions, (response) => {
                let body = "";
                response.on("data", chunk => body += chunk);
                response.on("end", () => console.log("LINE API response:", body));
            });

            request.on("error", err => console.error("Request error:", err));
            request.write(dataString);
            request.end();
        }
    });
});

app.listen(PORT, () => console.log(`Example app listening at http://localhost:${PORT}`));
