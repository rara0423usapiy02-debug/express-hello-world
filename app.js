const https = require("https");
const express = require("express");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_ACCESS_TOKEN;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_, res) => {
    res.sendStatus(200);
});

app.post("/webhook", (req, res) => {
    // ‚Ü‚¸ LINE ‚É 200 OK ‚ð•Ô‚·i‚±‚ê‚ª–³‚¢‚ÆLINE‘¤‚ªÄ‘—‚µ‚Ä‚µ‚Ü‚¤j
    res.status(200).end();

    console.log("Webhook event:", JSON.stringify(req.body, null, 2));

    if (req.body.events[0].type === "message") {
        const headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + TOKEN,
        };

        const dataString = JSON.stringify({
            replyToken: req.body.events[0].replyToken,
            messages: [
                { type: "text", text: "Hello, user" },
                { type: "text", text: "May I help you?" },
            ],
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
