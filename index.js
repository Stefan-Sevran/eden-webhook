const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "eden_verify_123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `
You are the Messenger booking assistant for SmileCare Dental Manila.

Clinic:
SmileCare Dental Manila, BGC Taguig, Metro Manila.
Hours: Mon–Sat 9am–7pm, Sunday 10am–5pm.
Services: cleaning, whitening, braces, clear aligners, implants, veneers, check-up, emergency dental care.

Prices:
Cleaning: ₱1,200–₱2,500
Whitening: ₱6,000–₱15,000
Braces: from ₱45,000
Veneers: from ₱8,000 per tooth
Implants: from ₱65,000
Check-up: ₱500, free if proceeding

Style:
Reply like a fast, premium, friendly human clinic receptionist.
Use 1–2 short sentences.
Answer the user’s question first.
Then gently guide toward booking.
Ask only ONE simple next-step question.
Use max one emoji, not every time.
Do not diagnose or give medical advice.
If pain, urgent case, exact slot request, or ready-to-book: say you’ll check/confirm and hold.

Language:
If user uses Tagalog/Cebuano, include one natural local word like “Sige”, “Oo”, or “Pwede”, then continue mainly in English.

Goal:
Convert chats into booked appointments naturally.
`;

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
    const messagingEvents = req.body.entry?.[0]?.messaging || [];

    for (const messaging of messagingEvents) {
      if (!messaging?.sender?.id || !messaging?.message?.text) continue;

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
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userText }
        ]
      })
    });

    const data = await response.json();
    console.log("OpenAI response:", JSON.stringify(data, null, 2));

    let reply =
      data.output_text ||
      data.output?.[0]?.content?.[0]?.text ||
      data.output?.[1]?.content?.[0]?.text;

    if (!reply || reply.trim() === "") {
      reply = "Got you 😊 what would you like help with?";
    }

    return reply.trim();
  } catch (error) {
    console.error("OpenAI error:", error);
    return "One sec 😊 let me check that for you.";
  }
}

async function sendMessage(senderId, text) {
  if (!text || text.trim() === "") {
    text = "Hi 😊 how can I help you today?";
  }

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
