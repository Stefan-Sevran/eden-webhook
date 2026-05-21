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

      await sendMessage(senderId, "Got your message 😄 Eden is now live.");
    }
  } catch (error) {
    console.error("Reply error:", error);
  }

  res.sendStatus(200);
});

async function sendMessage(senderId, text) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text }
      })
    }
  );

  const data = await response.json();
  console.log("Send response:", data);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
