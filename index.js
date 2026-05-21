const express = require("express");
const app = express();

app.use(express.json());

const VERIFY_TOKEN = "eden_verify_123";

// GET (Meta verification)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST (receive messages)
app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));

  const entry = req.body.entry?.[0];
  const messaging = entry?.messaging?.[0];

  if (messaging && messaging.sender && messaging.message) {
    const senderId = messaging.sender.id;
    const text = messaging.message.text;

    console.log("User said:", text);

    // 🔥 send reply
    await sendMessage(senderId, "Got your message 😄 Eden is now live.");
  }

  res.sendStatus(200);
});

async function sendMessage(senderId, text) {
  await fetch(`https://graph.facebook.com/v25.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text }
    })
  });
}
