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

      // 🧠 OpenAI call
      const aiResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.3",
          input: `You are a friendly clinic booking assistant.
Reply briefly, warmly, and guide toward booking.
Always end with one simple question.

User: ${userText}`
        })
      });

      const aiData = await aiResponse.json();
      const reply = aiData.output[0].content[0].text;

      console.log("AI:", reply);

      await sendMessage(senderId, reply);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("Error:", error);
    res.sendStatus(500);
  }
});
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
