const https = require("https");
const express = require("express");
// ポート番号
const PORT = process.env.PORT || 3000;
// Messaging APIを呼び出すためのトークン
const TOKEN = process.env.LINE_ACCESS_TOKEN;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true, }));
app.get("/", (_, res) => {
    res.sendStatus(200);
});
app.post("/webhook", (req, _) => {
    res.send("HTTP POST request sent to the webhook URL!");
    if (req.body.events[0].type === "message") {
        const headers = {
            "Content-Type": "application/json",
            Authorization: "Bearer " + TOKEN,
        };
        const dataString = JSON.stringify({
            replyToken: req.body.events[0].replyToken,
            messages: [
                {
                    type: "text",
                    text: "Hello, user",
                },
                {
                    type: "text",
                    text: "May I help you?"
                },
            ],
        });
        const webhookOptions = {
            hostname: "api.line.me",
            path: "/v2/bot/message/reply",
            method: "POST",
            headers: headers,
            body: dataString,
        }
        const request = https.request(webhookOptions, res => {
            res.on("data", d => {
                process.stdout.write(d);
            });
        });
        request.on("error", err => {
            console.error(err);
        });

        request.write(dataString);
        request.end();
    }
});
app.listen(PORT, () => {
    console.log(`Example app listening at http://localhost:${PORT}`);
});
