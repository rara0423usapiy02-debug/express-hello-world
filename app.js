const https = require("https");
const express = require("express");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// �������摜��URL���X�g�iGitHub�� raw URL �𗘗p�j
const rabbitImages = [
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051997_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564051999_0.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052000.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052001.jpg",
    "https://raw.githubusercontent.com/rara0423usapiy02-debug/express-hello-world/c19ba036deab7aebd1484d78191d27a8a7060b9c/huku/S__564052002.jpg"
    // ��������΂����ɒǉ�
];

app.get("/", (_, res) => {
    res.sendStatus(200);
});

app.post("/webhook", (req, res) => {
    // LINE �� 200 OK �������Ԃ��i��������Ȃ��ƍđ������j
    res.status(200).end();

    console.log("Webhook event:", JSON.stringify(req.body, null, 2));

    const event = req.body.events[0];

    if (event.type === "message" && event.message.type === "text") {
        const userMessage = event.message.text;
        let messages = [];

        if (userMessage === "test") {
            // �utest�v�̏ꍇ�̓e�L�X�g�ԐM
            messages = [
                { type: "text", text: "Hello, user" },
                { type: "text", text: "May I help you?" },
            ];
        } else if (userMessage === "������") {
            // �u�������v�̏ꍇ�̓����_���摜�ԐM
            const randomImage = rabbitImages[Math.floor(Math.random() * rabbitImages.length)];
            messages = [
                {
                    type: "image",
                    originalContentUrl: randomImage,
                    previewImageUrl: randomImage
                }
            ];
        } else {
            console.log("No reply sent (message was not 'test' or '������').");
            return;
        }

        // LINE API �ɕԐM���N�G�X�g�𑗐M
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
