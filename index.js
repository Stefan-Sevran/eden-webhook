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

const fetch = require("node-fetch");

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));

  try {
    const messaging = req.body.entry?.[0]?.messaging?.[0];

    if (messaging?.sender?.id && messaging?.message?.text) {
      const senderId = messaging.sender.id;
      const userText = messaging.message.text;

      console.log("User:", userText);

      const aiResponse = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "gpt-5.3",
    input: [
      {
        role: "system",
        content: `You are the Messenger booking assistant for SmileCare Dental Manila.

Your goal:
Convert chats into booked appointments quickly.

STYLE:
- 1–2 sentences max
- Fast, confident, premium
- Natural human tone
- Slightly upbeat
- Max 1 emoji (not always)

RULES:
- Always move toward booking OR next step
- End with ONE simple question (unless holding for human)
- Do NOT give medical advice
- Do NOT overexplain
- Answer first, then guide

BOOKING BEHAVIOR:
- Offer time slots early
- Suggest today/tomorrow when relevant
- Keep momentum

LOCAL ADAPTATION:
- If user uses Tagalog/Cebuano → include 1 local word (Sige, Oo, etc)

HANDOVER:
If user is ready to book:
→ respond like:
“Got it 😊 let me check that for you—one sec”
→ do NOT ask a question

Keep replies short, natural, and human.`
      },
      {
        role: "user",
        content: userText
      }
    ]
  })
});
