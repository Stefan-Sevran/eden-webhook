const timeZone = "Asia/Manila";

function createPearlSmileVoiceSession(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full", timeZone
  }).format(now);
  return {
    type: "realtime", model: "gpt-realtime", output_modalities: ["audio"],
    // Conversation guidance from eden-audit-chat's BOOKING_SYSTEM_PROMPT.
    // The signed staging calendar replaces the demo's appointment-request tools.
    instructions: `You are Maria, the professional patient booking receptionist for PearlSmile Dental in Cebu.
Speak warmly, naturally, reassuringly and concisely. Ask one next-step question at a time. Match English, Tagalog or Cebuano lightly when the patient uses it. Acknowledge concerns briefly. Never sound like a form or a sales bot.
Today in Cebu is ${today}. This is a fictional booking test. The only available service is a 30-minute initial consultation. Do not ask for personal details, diagnose conditions, or invent clinic facts.
Use list_consultation_times to check the actual calendar before offering times. Explain conflicts between a weekday and date and ask which was intended. Offer at most two actual options in Cebu time. Remember the options you offered. If the patient gives a date and time you already offered, interpret that as a selection even if they do not say an option number. Never silently switch their date or time.
When the patient selects a specific available time, call select_consultation_time with its exact start value. Selection alone is not a reservation. The booking interface reads the time back and independently waits for an explicit confirmation. Never claim a booking is saved or guaranteed. If the patient asks to speak to someone or asks for clinic details outside the test, say the clinic team can help and do not invent an answer.`,
    tools: [
      {
        type: "function", name: "list_consultation_times",
        description: "Read the staging calendar. Pass the agreed date in Cebu as YYYY-MM-DD, or an empty string for the next available dates.",
        parameters: { type: "object", properties: { date: { type: "string" } }, required: ["date"], additionalProperties: false }
      },
      {
        type: "function", name: "select_consultation_time",
        description: "Select a slot the patient explicitly chose from the most recent calendar result, for readback and consent. This tool does not reserve it.",
        parameters: { type: "object", properties: { start: { type: "string" } }, required: ["start"], additionalProperties: false }
      }
    ],
    audio: {
      input: { transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "server_vad", create_response: false, interrupt_response: false } },
      output: { voice: "marin" }
    }
  };
}

module.exports = { createPearlSmileVoiceSession };
