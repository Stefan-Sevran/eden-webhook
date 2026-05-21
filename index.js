const express = require("express");
const app = express();

app.use(express.json());

const VERIFY_TOKEN = "eden_verify_123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));

  try {
    const messaging = req.body.entry?.[0]?.messaging?.[0];

    if (messaging?.sender?.id && messaging?.message?.text) {
      const senderId = messaging.sender.id;
      const userText = messaging.message.text;

      const aiResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.3",
          temperature: 0.7,
          input: [
            {
              role: "system",
              content: "You are the Messenger booking assistant for SmileCare Dental Manila. Reply warmly, briefly, premium and human. 1–2 sentences max. Answer first, then guide toward booking. End with one simple question unless holding for human takeover. Never diagnose or give medical advice."
            },
            {
              role: "user",
              content: userText
            }
          ]
        })
      });

      const aiData = await aiResponse.json();
      const reply = aiData.output?.[0]?.content?.[0]?.text || "Hi 😊 how can I help you today?";

      await sendMessage(senderId, reply);
    }
  } catch (error) {
    console.error("Error:", error);
  }

  res.sendStatus(200);
});
