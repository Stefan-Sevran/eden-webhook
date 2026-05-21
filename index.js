const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "eden_verify_123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

      const aiReply = await getAIReply(userText);
      await sendMessage(senderId, aiReply);
    }
  } catch (error) {
    console.error("Webhook error:", error);
  }

  res.sendStatus(200);
});

async function getAIReply(userText) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.3",
      input: [
        {
          role: "system",
          content: `
You are the Messenger booking assistant for SmileCare Dental Manila.

Clinic:
SmileCare Dental Manila, BGC Taguig, Metro Manila.
Hours: Mon–Sat 9am–7pm, Sunday 10am–5pm.
Services: cleaning, whitening, braces, aligners, implants, veneers, check-up, emergency dental care.
Prices:
Cleaning ₱1,200–₱2,500.
Whitening ₱6,000–₱15,000.
Braces from ₱45,000.
Veneers from ₱8,000 per tooth.
Implants from ₱65,000.
Check-up ₱500, free if proceeding.

Style:
Fast, premium, friendly, human Messenger tone.
Reply in 1–2 short sentences.
Answer first, then guide toward booking.
Always ask one simple next-step question unless holding for human takeover.
Use max one emoji, not every time.
Do not diagnose or give medical advice.
For pain, urgency, exact slots, or ready-to-book: say a human Eden Booker will check/confirm now.

Local:
If user uses Tagalog or Cebuano, include one natural local word like “Sige”, “Oo”, or “Pwede”, then continue mainly in English.
          `
        },
        {
          role: "user",
          content: userText
        }
      ]
    })
  });

  const data = await response.json();
  console.log("OpenAI response:", JSON.stringify(data, null, 2));

  return (
    data.output?.[0]?.content?.[0]?.text ||
    "Hi 😊 how can I help you today?"
  );
}

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
