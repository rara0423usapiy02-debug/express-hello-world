//const https = require("https");
//const express = require("express");

//const PORT = process.env.PORT || 3000;
//const TOKEN = process.env.LINE_ACCESS_TOKEN;
//const app = express();

//app.use(express.json());
//app.use(express.urlencoded({ extended: true }));

//// 画像のURLリスト（GitHubの raw URL を利用）
//const rabbitImages = [
//    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051997_0.jpg",
//    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051999_0.jpg",
//    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052000.jpg",
//    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052001.jpg",
//    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052002.jpg"
//];

//app.get("/", (_, res) => {
//    res.sendStatus(200);
//});

//app.post("/webhook", (req, res) => {
//    // LINE に 200 OK を即返す
//    res.status(200).end();

//    const event = req.body.events[0];

//    if (event.type === "message" && event.message.type === "text") {
//        const userMessage = event.message.text.trim();
//        console.log("User message:", userMessage);
//        console.log("Char codes:", Array.from(userMessage).map(c => c.charCodeAt(0)));

//        let messages = [];

//        // テキスト "test" に反応
//        if (userMessage === "test") {
//            messages = [
//                { type: "text", text: "Hello, user" },
//                { type: "text", text: "May I help you?" },
//            ];
//        }
//        // 「huku」を含む場合にランダム画像返信
//        else if (userMessage.match(/huku/)) {
//            const randomImage = rabbitImages[Math.floor(Math.random() * rabbitImages.length)];
//            messages = [
//                {
//                    type: "image",
//                    originalContentUrl: randomImage,
//                    previewImageUrl: randomImage
//                }
//            ];
//        } else {
//            console.log("No reply sent (message was neither 'test' nor 'huku').");
//            return;
//        }

//        // LINE API に返信
//        const headers = {
//            "Content-Type": "application/json",
//            "Authorization": "Bearer " + TOKEN,
//        };

//        const dataString = JSON.stringify({
//            replyToken: event.replyToken,
//            messages: messages,
//        });

//        console.log("Request body to LINE API:", dataString);

//        const webhookOptions = {
//            hostname: "api.line.me",
//            path: "/v2/bot/message/reply",
//            method: "POST",
//            headers: headers,
//        };

//        const request = https.request(webhookOptions, (response) => {
//            let body = "";
//            console.log("LINE API status code:", response.statusCode);

//            response.on("data", (chunk) => {
//                body += chunk;
//            });

//            response.on("end", () => {
//                console.log("LINE API response body:", body);
//            });
//        });

//        request.on("error", (err) => {
//            console.error("Request error:", err);
//        });

//        request.write(dataString);
//        request.end();
//    }
//});

//app.listen(PORT, () => {
//    console.log(`Example app listening at http://localhost:${PORT}`);
//});
const https = require("https");
const express = require("express");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// FAQデータ（結婚式参列者向け）
const faqData = {
    "駐車場": {
        q: "駐車場はありますか？",
        a: "会場専用の駐車場をご利用いただけます。満車の場合は近隣のコインパーキングをご案内いたします。"
    },
    "服装": {
        q: "服装の指定はありますか？",
        a: "平服でお越しください。男性はスーツ、女性はセミフォーマルがおすすめです。白いドレスは花嫁と重なるためご遠慮ください。"
    },
    "ご祝儀": {
        q: "ご祝儀はどうすればいいですか？",
        a: "受付にてお渡しください。袱紗に包んでご持参いただけると丁寧です。"
    },
    "受付時間": {
        q: "受付は何時から始まりますか？",
        a: "挙式の30分前から受付を開始いたします。混雑が予想されますのでお早めにお越しください。"
    },
    "写真撮影": {
        q: "写真撮影はしてもいいですか？",
        a: "挙式中はご遠慮いただき、披露宴中は自由に撮影いただけます。SNS投稿の際は新郎新婦にご確認ください。"
    }
};

// 質問一覧（FAQリスト）を作るFlex Message
const faqListFlex = {
    type: "flex",
    altText: "結婚式FAQリスト",
    contents: {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                {
                    type: "text",
                    text: "💒 結婚式 FAQ",
                    weight: "bold",
                    size: "lg",
                    align: "center"
                },
                {
                    type: "separator",
                    margin: "md"
                },
                ...Object.keys(faqData).map(key => ({
                    type: "button",
                    style: "secondary",
                    action: {
                        type: "message",
                        label: faqData[key].q,
                        text: "FAQ:" + key
                    },
                    margin: "sm"
                }))
            ]
        }
    }
};

// 特定の質問と回答を返すFlex Message
const makeFaqAnswerFlex = (key) => ({
    type: "flex",
    altText: faqData[key].q,
    contents: {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                {
                    type: "text",
                    text: "Q. " + faqData[key].q,
                    weight: "bold",
                    size: "md"
                },
                {
                    type: "text",
                    text: "A. " + faqData[key].a,
                    wrap: true,
                    size: "sm",
                    margin: "md"
                }
            ]
        }
    }
});

app.get("/", (_, res) => {
    res.sendStatus(200);
});

app.post("/webhook", (req, res) => {
    res.status(200).end(); // LINEにすぐ200を返す

    const event = req.body.events[0];

    if (event.type === "message" && event.message.type === "text") {
        const userMessage = event.message.text.trim();
        console.log("User message:", userMessage);

        let messages = [];

        // 「faq」と送信されたらFAQリストを返す
        if (userMessage.toLowerCase() === "faq") {
            messages = [faqListFlex];
        }
        // 「FAQ:〇〇」で始まる場合 → 個別の回答を返す
        else if (userMessage.startsWith("FAQ:")) {
            const key = userMessage.replace("FAQ:", "").trim();
            if (faqData[key]) {
                messages = [makeFaqAnswerFlex(key)];
            } else {
                messages = [{ type: "text", text: "その質問には対応していません。" }];
            }
        }
        // デモ用: test
        else if (userMessage === "test") {
            messages = [
                { type: "text", text: "Hello, user" },
                { type: "text", text: "May I help you?" }
            ];
        } else {
            console.log("No reply sent (message did not match).");
            return;
        }

        // LINE APIに送信
        const headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + TOKEN,
        };

        const dataString = JSON.stringify({
            replyToken: event.replyToken,
            messages: messages,
        });

        console.log("Request body to LINE API:", dataString);

        const webhookOptions = {
            hostname: "api.line.me",
            path: "/v2/bot/message/reply",
            method: "POST",
            headers: headers,
        };

        const request = https.request(webhookOptions, (response) => {
            let body = "";
            console.log("LINE API status code:", response.statusCode);

            response.on("data", (chunk) => {
                body += chunk;
            });

            response.on("end", () => {
                console.log("LINE API response body:", body);
            });
        });

        request.on("error", (err) => {
            console.error("Request error:", err);
        });

        request.write(dataString);
        request.end();
    }
});

app.listen(PORT, () => {
    console.log(`Example app listening at http://localhost:${PORT}`);
});
