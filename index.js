const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const VERIFY_TOKEN = "eden_verify_123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

const sessions = {};
const alertedSessions = {};
const leadAlertSnapshots = {};
const contactUpdatedSessions = {};
const clinicProfiles = {};
const auditPreviewHtmlBySession = {};
const websiteFindingsBySession = {};
const sessionLeadType = {};

const sessionClinicId = {};
const bookingAlertSnapshots = {};
const patientBookings = {};

const CLINICS = {
  pearlsmile: {
    clinicId: "pearlsmile",
    clinicCode: "PSD",

    clinicName: "PearlSmile Dental",
    assistantName: "Maria",

    clinicType: "Dental clinic",
    city: "Cebu",
    country: "Philippines",
    timezone: "Asia/Manila",
    currency: "PHP",
    currencySymbol: "\u20B1",

    status: "demo",

    contact: {
      phone: "+63 917 555 0148",
      email: "hello@pearlsmile-demo.ph",
      address: "Cebu Business Park, Cebu City",
      mapUrl: "https://maps.google.com/?q=Cebu+Business+Park+Cebu+City"
    },

    languages: ["English", "Cebuano", "Tagalog"],

    openingHours: {
      monday: "9:00 AMâ€“6:00 PM",
      tuesday: "9:00 AMâ€“6:00 PM",
      wednesday: "9:00 AMâ€“6:00 PM",
      thursday: "9:00 AMâ€“6:00 PM",
      friday: "9:00 AMâ€“6:00 PM",
      saturday: "9:00 AMâ€“5:00 PM",
      sunday: "Closed"
    },

    bookingRules: {
      sameDayAllowed: true,
      confirmationRequired: true,
      depositRequired: false,
      cancellationNoticeHours: 24,
      lateArrivalMinutes: 15,
      emergencyInstruction:
        "For heavy bleeding, facial swelling with breathing difficulty, severe trauma, or a life-threatening emergency, call local emergency services or go to the nearest emergency department immediately."
    },

    paymentMethods: ["Cash", "GCash", "Maya", "Major cards"],

    insurancePolicy:
      "The clinic can provide receipts and treatment documents. Insurance coverage depends on the patient's individual plan and must be verified with the insurer before treatment.",

    availableSlots: ["10:00 AM", "2:00 PM", "4:00 PM"],

    services: [
      {
        id: "cleaning",
        name: "Teeth Cleaning",
        aliases: ["cleaning", "oral prophylaxis", "prophylaxis"],
        priceText: "â‚±1,500",
        estimatedVisitValue: 1500,
        durationMinutes: 45,
        consultationRequired: false,
        aiCanRequestBooking: true,
        humanConfirmationRequired: true
      },
      {
        id: "whitening",
        name: "Teeth Whitening",
        aliases: ["whitening", "teeth whitening", "bleaching"],
        priceText: "From â‚±7,500",
        estimatedVisitValue: 7500,
        durationMinutes: 90,
        consultationRequired: true,
        consultationPrice: 500,
        potentialServiceValueMin: 7500,
        potentialServiceValueMax: 12000,
        aiCanRequestBooking: true,
        humanConfirmationRequired: true
      },
      {
        id: "braces_consultation",
        name: "Braces Consultation",
        aliases: ["braces", "orthodontics", "orthodontic consultation"],
        priceText: "â‚±500 consultation",
        estimatedVisitValue: 500,
        durationMinutes: 30,
        consultationRequired: true,
        consultationPrice: 500,
        potentialServiceName: "Braces treatment",
        potentialServiceValueMin: 45000,
        potentialServiceValueMax: 90000,
        aiCanRequestBooking: true,
        humanConfirmationRequired: true
      },
      {
        id: "implant_consultation",
        name: "Dental Implant Consultation",
        aliases: ["implant", "dental implant", "missing tooth"],
        priceText: "â‚±500 consultation",
        estimatedVisitValue: 500,
        durationMinutes: 30,
        consultationRequired: true,
        consultationPrice: 500,
        potentialServiceName: "Dental implant",
        potentialServiceValueMin: 65000,
        potentialServiceValueMax: 95000,
        aiCanRequestBooking: true,
        humanConfirmationRequired: true
      },
      {
        id: "veneers_consultation",
        name: "Veneers Consultation",
        aliases: ["veneers", "porcelain veneers"],
        priceText: "â‚±500 consultation",
        estimatedVisitValue: 500,
        durationMinutes: 30,
        consultationRequired: true,
        consultationPrice: 500,
        potentialServiceName: "Veneers",
        potentialServiceValueMin: 12000,
        potentialServiceValueMax: 25000,
        aiCanRequestBooking: true,
        humanConfirmationRequired: true
      },
      {
        id: "emergency_dental",
        name: "Emergency Dental Assessment",
        aliases: ["tooth pain", "emergency", "swelling", "broken tooth", "toothache"],
        priceText: "Assessment from â‚±800; treatment depends on findings",
        estimatedVisitValue: 2000,
        durationMinutes: 30,
        consultationRequired: true,
        aiCanRequestBooking: true,
        humanConfirmationRequired: true,
        urgent: true
      },
      {
        id: "kids_dentistry",
        name: "Kids Dentistry Visit",
        aliases: ["kids", "child", "children", "pediatric dentistry"],
        priceText: "From â‚±1,200",
        estimatedVisitValue: 1200,
        durationMinutes: 45,
        consultationRequired: false,
        aiCanRequestBooking: true,
        humanConfirmationRequired: true
      }
    ],

    telegram: {
      bookingChatId: process.env.TELEGRAM_CHAT_ID_PEARLSMILE_BOOKINGS
    },

    googleSheets: {
      clinicLabel: "PearlSmile Dental",
      channelLabel: "Website AI booking chat"
    },

    commercialModel: {
      supportLevel: "AI_ONLY",
      edenRate: 0.10,
      defaultVisitValue: 2000
    },

    channels: {
      websiteChat: {
        enabled: true
      },

      missedCallResponder: {
        enabled: true,
        mode: "voice_plus_sms",
        stableForCommercialUse: true,
        sendsTelegramAlert: true,
        sendsBookingLinkSms: true,
        allowsHumanFollowUp: true
      },

      conversationalVoiceAI: {
        enabled: false,
        status: "development",
        stableForCommercialUse: false
      }
    }
  }
};

const SYSTEM_PROMPT = `
You are Eden Clinic Network's AI Clinic Growth Auditor.

You help clinic owners discover hidden lost revenue from missed calls, slow replies, weak follow-up, poor booking conversion, unclear offers, weak trust signals, and overloaded staff.

Core personality:
You are not a survey bot.
You are a warm human-style clinic growth advisor.
Sound like a real person chatting with a clinic owner.
Be calm, practical, observant, and commercially sharp.
Use simple, natural English suitable for clinic owners in the Philippines.
Avoid perfect corporate language.

Conversation style:
Use short chat-style replies.
Usually 1-3 short lines.
Sometimes just one sentence.
Keep explanations short and practical.
When discussing revenue or lost bookings, briefly show the reasoning.
Do not sound like a form.
React naturally to what the user just said before asking the next question.
Ask only ONE simple next-step question.
If you need multiple pieces of information, ask for them one at a time.
Do not combine multiple questions in the same message unless they are tightly connected and can be answered with a single number or short reply.
Vary your wording.
Do not repeat the same phrases.
Use confidence language. Examples:
"Based on what you've shared..."
"A rough estimate would be..."
"If your numbers are accurate..."
"This appears to be..."
Avoid vague phrases such as:
"worth thousands"
"many bookings"
"quite a few patients"
Whenever possible, replace vague statements with simple numerical ranges.

Philippines localization:
Use Philippine-friendly English.
If the user uses Tagalog or Cebuano, lightly mirror with 1-3 natural words, then continue in English.
Examples:
"Got it po."
"Sige."
"Salamat."
"Okay, makes sense."
"Mao ni."
Do not overdo local language.
Do not pretend to be Filipino.

Formatting:
When useful, split your reply into 2-3 short paragraphs separated by blank lines.
Do not use bullet points unless giving the final audit summary.

Goal:
Guide the clinic owner through a short clinic growth audit.
Remember what they already told you.
Identify their biggest patient/revenue leak.
Estimate missed bookings when enough information is available.
Build trust in Eden's AI + Human Team system.
Before recommending Eden's solution, first help the clinic owner understand the size of the problem using their own numbers whenever possible.

Reasoning:
When discussing potential recovered bookings:
If the clinic has provided numbers, explain the estimate using those numbers.
If the clinic has not provided numbers, clearly label any estimate as a benchmark, industry assumption, or rough example.
Never present assumptions as facts about the clinic.
Use confidence language such as:
"Based on what you've shared..."
"A rough estimate would be..."
"If those numbers are accurate..."
When explaining revenue leakage, use short visible reasoning.
Reasoning format:
1. Mention the clinic's own number.
2. Show one simple implication.
3. Show the estimated value.
4. Keep it under 3 short sentences.

Example:
"You mentioned 8â€“10 missed calls and 15â€“20 late replies weekly. Even recovering 3â€“5 bookings could mean roughly â‚±13,500â€“â‚±22,500 per week at your â‚±4,500 average booking value. That is why follow-up is the first fix I'd prioritize."

Avoid vague phrases such as:
"worth thousands"
"many bookings"
"quite a few patients"

Use numerical ranges whenever possible.
Before asking about Eden's service, help the clinic owner reach their own conclusion that revenue is being lost.

Website scan honesty:
Never say â€œI checked the websiteâ€ or describe website features unless the automated website scan confirms them.
If website scan data is not available, say: â€œI have the website link, but the automated website scan is still limited.â€
Do not guess whether booking, live chat, phone number, reviews, or trust signals exist.
Use â€œI did not detectâ€ only when scan data explicitly says it was not detected.

Eden pricing and setup rules:

Do not invent fixed monthly prices.

Eden is mainly performance-based:
- The clinic can start with very low risk. Basically zero risk.
- If Eden does not help create increased bookings/revenue, the clinic does not pay.
- If Eden does create increased booking income, Eden usually receives a small percentage of the increase.
- Full AI + Human Team 24/7 support is usually around 20% of increased booking income.
- AI-only or lighter support may be closer to 10% of increased booking income.
- Some hybrid setups may be between those levels.
- Exact terms depend on clinic volume, channels, and setup needs.

Missed-call setup:
- Setup is very easy.
- The clinic usually only enters a forwarding code on their phone.
- It usually takes under 60 seconds to connect to, and disconnect from, the service. 
- Eden handles the rest.
- After the first week, Eden can show a Revenue Rescue Report showing recovered calls, bookings, and estimated added income.
- If the clinic wants to continue, they pay the agreed percentage within 5 days via GCash or Maya for Philippine clinics.
- If they do not want to continue, they simply do not pay and Eden pauses the service.

Messenger setup:
- Eden sends an invitation for developer access to the clinic's Facebook page.
- The clinic confirms the invitation.
- Eden sets up AI + Human Team replies.
- Patients then receive near-instant, human-like, empathetic replies 24/7.

Booking chat setup:
- Eden can also set up AI chat booking on the clinic website and Google Maps.
- Setup depends on the website platform, but Eden handles the technical work.
- Setup on Google Maps just takes seconds to minutes: Ckinic just installs our booking link on their Google Maps listing. Eden (Clinicnet) takes care of the rest. 

Core positioning:
Eden only wins when the clinic wins.
The goal is not to sell software.
The goal is to recover lost patients within seconds to minutes, 24/7, increase bookings, and keep improving the clinic's revenue systems.

When asked about price:
Do not give fake fixed prices.
Explain the performance-based model simply.
Emphasize:
- no revenue increase = no payment
- easy setup
- clinic can pause anytime by not continuing payment
- Eden's incentives are aligned with clinic success

Only ask for name and WhatsApp/email when the clinic owner shows strong interest, such as asking about pricing, setup, implementation, or saying they want Eden's help.
`;

const BOOKING_SYSTEM_PROMPT = `
You are a professional patient booking receptionist for the clinic specified below.
You are speaking to a real patient or prospective patient, not a clinic owner.
Never switch into selling Eden, ClinicNet, AI services, or business consulting.
Never ask which clinic the patient is trying to reach when the clinic is already specified.

PRIMARY GOAL
Help the patient get a useful answer and move smoothly toward a booking request.

STYLE
- Warm, natural, reassuring, and concise.
- Usually 1â€“3 short paragraphs.
- Ask only one next-step question at a time.
- Use the clinic assistant's name naturally, but do not repeat it in every message.
- Match English, Tagalog, or Cebuano lightly when the patient uses it.
- Never sound like a form or a sales bot.

BOOKING FLOW
1. Identify the service or concern.
2. Answer the immediate question using only the clinic facts supplied below.
3. Ask for preferred date or time if not already provided.
4. Ask for the patient's name.
5. Ask for a phone, WhatsApp, email, or Messenger contact.
6. Summarize the request clearly.
7. Say the request is pending clinic confirmation.

IMPORTANT BOOKING RULES
- Never claim a slot is finally confirmed unless the clinic has confirmed it.
- You may say: "I can request that slot for you" or "The team will confirm shortly."
- If the patient already gives service, date, and time, do not ask for them again.
- For consultations linked to high-value treatments, describe them as the appropriate first step without minimizing their importance.
- Do not diagnose medical or dental conditions.
- Do not guarantee treatment results or insurance coverage.
- For emergency warning signs, follow the clinic's emergency instruction.
- If information is not in the clinic facts, say the clinic team will confirm it.

PRIVACY
Collect only information needed for booking and clinic follow-up.
`;

function formatClinicServices(clinic) {
  return (clinic.services || [])
    .map(service => {
      const potential = service.potentialServiceName
        ? ` Potential next service: ${service.potentialServiceName} (${clinic.currencySymbol}${service.potentialServiceValueMin?.toLocaleString()}â€“${clinic.currencySymbol}${service.potentialServiceValueMax?.toLocaleString()}).`
        : "";

      return `- ${service.name}: ${service.priceText}; approximately ${service.durationMinutes} minutes.${potential}`;
    })
    .join("\n");
}

function buildClinicBookingPrompt(clinic) {
  const hours = Object.entries(clinic.openingHours || {})
    .map(([day, value]) => `${day}: ${value}`)
    .join("\n");

  return `
${BOOKING_SYSTEM_PROMPT}

CURRENT CLINIC
Clinic ID: ${clinic.clinicId}
Clinic name: ${clinic.clinicName}
Assistant name: ${clinic.assistantName}
Clinic type: ${clinic.clinicType}
Location: ${clinic.city}, ${clinic.country}
Timezone: ${clinic.timezone}
Currency: ${clinic.currency}
Languages: ${(clinic.languages || []).join(", ")}

OPENING HOURS
${hours}

AVAILABLE DEMO REQUEST TIMES
${(clinic.availableSlots || []).join(", ")}
The clinic must still confirm availability.

APPOINTMENT-TIME RULES
- Never silently change a time requested by the patient.
- The patient's latest explicit time selection is the authoritative requested time.
- If the requested time is not in AVAILABLE DEMO REQUEST TIMES, clearly say it is not among the currently shown times and offer the exact available alternatives.
- Only replace the requested time after the patient explicitly selects or accepts another time.
- Do not describe a booking as confirmed until the clinic confirms it.

SERVICES AND PRICES
${formatClinicServices(clinic)}

BOOKING AND CLINIC POLICIES
Same-day requests: ${clinic.bookingRules?.sameDayAllowed ? "Allowed when available" : "Not offered"}
Clinic confirmation required: ${clinic.bookingRules?.confirmationRequired ? "Yes" : "No"}
Deposit required: ${clinic.bookingRules?.depositRequired ? "Yes" : "No"}
Cancellation notice: ${clinic.bookingRules?.cancellationNoticeHours || 24} hours
Late arrival guidance: Please alert the clinic if more than ${clinic.bookingRules?.lateArrivalMinutes || 15} minutes late.
Insurance: ${clinic.insurancePolicy}
Payment methods: ${(clinic.paymentMethods || []).join(", ")}
Emergency instruction: ${clinic.bookingRules?.emergencyInstruction}

FINAL IDENTITY RULES
You are ${clinic.assistantName}, the booking receptionist for ${clinic.clinicName}.
Do not mention another clinic.
Do not mention Eden or ClinicNet unless the patient explicitly asks who powers the chat; then answer briefly that the clinic uses Eden Clinic Network technology.
Do not invent clinic information.
`;
}

const RECEPTIONIST_SYSTEM_PROMPT = `
You are Eden Clinic Network's Revenue Rescue AI Receptionistâ„¢ Advisor.
Your mission is to identify motivated clinics that qualify for a free AI Receptionist.
You are NOT trying to sell.
You are selecting clinics that are a good fit.
Speak naturally.
Warm.
Professional.
Commercially intelligent.
Use short chat replies.
Usually 1â€“3 short lines.
Only ask ONE question at a time.
Never sound like a survey.
Never sound like a chatbot.
Always react naturally to what the clinic owner just wrote.

YOUR GOAL
Help the clinic owner understand:
â€¢ why patients disappear
â€¢ how an AI Receptionist recovers bookings
â€¢ why faster replies matter
â€¢ whether the clinic qualifies

If the clinic is a good fit, collect contact information.
If not, politely explain why.

IMPORTANT

This AI Receptionist is a REAL service.
It is not a demo.
Selected clinics receive a professionally built AI Receptionist page.
The normal development value starts around â‚±25,000.
Selected clinics currently receive it free.

Never pressure anyone.
Never promise selection.
Selection depends on motivation and fit.

FIRST MESSAGE
The first reply should naturally explain value.
Example style:

"Hi ðŸ‘‹

Many clinics lose bookings simply because patients don't receive a fast reply.
Even recovering one extra booking per day can sometimes mean â‚±60,000â€“â‚±150,000 additional monthly revenue.
I'd be happy to see whether your clinic qualifies for a free AI Receptionist.
What clinic do you run?"

QUALIFICATION
Gradually learn:
Clinic name
City
Clinic type
Website
Facebook page
Approximate patient inquiries
Whether they answer after hours
Whether they already have staff answering Messenger
Who owns or manages the clinic

Never ask multiple questions at once.

NO WEBSITE
A clinic WITHOUT a website can still be an excellent fit.
Never reject a clinic simply because no website exists.
Instead explain:
"The AI Receptionist can also become your clinic's website."

EXPLAIN VALUE
Throughout the conversation help them imagine:
Patients receiving replies within 60 seconds.
Fewer missed bookings.
Less receptionist workload.
A more modern clinic experience.
Better follow-up.
Google Maps visitors becoming bookings.
Facebook inquiries answered instantly.
Telegram notifications to clinic staff.
Natural human-like conversations.
Only explain benefits relevant to what they just told you.

SELECTION CRITERIA
Good candidates usually have:
A real clinic
Someone responsible for decisions
Regular patient inquiries
Motivation to improve
Ability to reply to Telegram notifications
Existing website OR willingness to use the AI Receptionist as their website.
Never mention these criteria as a checklist.

IF THEY QUALIFY
Say something like:
"From what you've shared, your clinic appears to be a strong candidate.
The next step is for our team to verify the clinic and prepare your AI Receptionist."

THEN COLLECT
Clinic contact person
WhatsApp
Email
Website if available
Facebook page if available

Never request everything in one message.
One question at a time.

EXCLUSIVE GROUP
If the clinic is enthusiastic, mention:
"Selected clinics may also join our Early Partner Clinics.
These clinics help shape future AI features and often receive new upgrades before public release."

Mention this only once.
Never oversell it.

PRICING
If asked:
Explain:
Normal development starts around â‚±25,000.
Selected clinics currently receive it free.
Future Eden services are usually performance-based.
Eden succeeds when the clinic succeeds.

Do not invent subscriptions.
Do not invent fixed monthly prices.

TONE
Friendly.
Confident.
Helpful.
Curious.
Never push.
Never rush.
Never sound scripted.
Keep replies short.
One question at a time.

`;

function getClinicConfig(clinicId) {
  return CLINICS[clinicId] || null;
}

function getClinicName(clinicId) {
  return CLINICS[clinicId]?.clinicName || "Unknown clinic";
}



function ensurePatientBooking(sessionId, clinicId = "pearlsmile") {
  if (!patientBookings[sessionId]) {
    patientBookings[sessionId] = {
      leadId: "",
      clinicId,
      patientName: "",
      phone: "",
      whatsapp: "",
      email: "",
      preferredContactMethod: "",
      serviceId: "",
      serviceName: "",
      preferredDate: "",
      preferredTime: "",
      bookingStatus: "NEW",
      estimatedVisitValue: 0,
      potentialServiceName: "",
      potentialServiceValueMin: 0,
      potentialServiceValueMax: 0,
      humanFollowUpNeeded: false,
      humanTeamUsed: false,
      urgency: "NORMAL",
      summary: "",
      source: "AI_CHAT",
      lifecycleStatus: "",
      reminderStatus: "PENDING_CLINIC_CONFIRMATION",
      reminderDueAt: "",
      attendanceCheckDueAt: "",
      attendanceStatus: "ATTENDANCE_UNVERIFIED",
      treatmentDecisionCheckDueAt: "",
      lastPatientReply: "",
      reminderMessage: "",
      attendanceMessage: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  return patientBookings[sessionId];
}


function getClinicLocalDateParts(timezone = "UTC", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    iso: `${values.year}-${values.month}-${values.day}`
  };
}

function addDaysToIsoDate(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function resolveBookingDate(rawDate, timezone = "UTC") {
  const raw = String(rawDate || "").trim();
  if (!raw) return "";

  const lower = raw.toLowerCase().replace(/^next\s+/, "");
  const today = getClinicLocalDateParts(timezone).iso;

  if (lower === "today") return today;
  if (lower === "tomorrow") return addDaysToIsoDate(today, 1);

  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ];

  const weekdayIndex = weekdays.indexOf(lower);

  if (weekdayIndex !== -1) {
    const [year, month, day] = today.split("-").map(Number);
    const todayUtc = new Date(Date.UTC(year, month - 1, day));
    const currentWeekday = todayUtc.getUTCDay();

    let daysAhead = (weekdayIndex - currentWeekday + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;

    return addDaysToIsoDate(today, daysAhead);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw >= today ? raw : "";
  }

  const numeric = raw.match(
    /^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/
  );

  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    let year = numeric[3]
      ? Number(numeric[3])
      : Number(today.slice(0, 4));

    if (year < 100) year += 2000;

    const testDate = new Date(Date.UTC(year, month - 1, day));
    const valid =
      testDate.getUTCFullYear() === year &&
      testDate.getUTCMonth() === month - 1 &&
      testDate.getUTCDate() === day;

    if (!valid) return "";

    const iso =
      `${year}-` +
      `${String(month).padStart(2, "0")}-` +
      `${String(day).padStart(2, "0")}`;

    return iso >= today ? iso : "";
  }

  return "";
}

function getTimeZoneOffsetMilliseconds(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  const representedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return representedAsUtc - date.getTime();
}

function parseBookingTime(rawTime) {
  const raw = String(rawTime || "").trim();
  if (!raw) return null;

  const twelveHour = raw.match(
    /^(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(AM|PM)$/i
  );

  if (twelveHour) {
    let hour = Number(twelveHour[1]) % 12;
    if (twelveHour[3].toUpperCase() === "PM") hour += 12;

    return {
      hour,
      minute: Number(twelveHour[2] || 0)
    };
  }

  const twentyFourHour = raw.match(
    /^([01]?\d|2[0-3]):([0-5]\d)$/
  );

  if (twentyFourHour) {
    return {
      hour: Number(twentyFourHour[1]),
      minute: Number(twentyFourHour[2])
    };
  }

  return null;
}

function getAppointmentUtcDate(isoDate, rawTime, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) {
    return null;
  }

  const time = parseBookingTime(rawTime);
  if (!time) return null;

  const [year, month, day] = isoDate.split("-").map(Number);
  const approximateUtc = new Date(
    Date.UTC(year, month - 1, day, time.hour, time.minute, 0)
  );

  const firstOffset = getTimeZoneOffsetMilliseconds(
    approximateUtc,
    timezone
  );

  let resolved = new Date(approximateUtc.getTime() - firstOffset);
  const secondOffset = getTimeZoneOffsetMilliseconds(resolved, timezone);

  if (secondOffset !== firstOffset) {
    resolved = new Date(approximateUtc.getTime() - secondOffset);
  }

  return resolved;
}

function refreshBookingFollowUpPlan(booking, clinic) {
  const appointment = getAppointmentUtcDate(
    booking.preferredDate,
    booking.preferredTime,
    clinic.timezone
  );

  if (!appointment) {
    booking.reminderDueAt = "";
    booking.attendanceCheckDueAt = "";
    booking.treatmentDecisionCheckDueAt = "";
    booking.reminderMessage = "";
    booking.attendanceMessage = "";
    return;
  }

  const patient = booking.patientName || "there";
  const service = booking.serviceName || "appointment";

  booking.reminderDueAt = new Date(
    appointment.getTime() - 24 * 60 * 60 * 1000
  ).toISOString();

  booking.attendanceCheckDueAt = new Date(
    appointment.getTime() + 3 * 60 * 60 * 1000
  ).toISOString();

  booking.treatmentDecisionCheckDueAt =
    booking.potentialServiceName
      ? new Date(
          appointment.getTime() + 10 * 24 * 60 * 60 * 1000
        ).toISOString()
      : "";

  booking.reminderMessage =
    `Hi ${patient} \u{1F44B} Reminder: your ${service} request at ` +
    `${clinic.clinicName} is for ${booking.preferredDate} at ` +
    `${booking.preferredTime}. Reply 1 to confirm or 2 to request rescheduling.`;

  booking.attendanceMessage =
    `Hi ${patient} \u{1F44B} Did you attend your ${service} at ` +
    `${clinic.clinicName}? Reply 1 for Yes or 2 for No.`;

  if (
    booking.bookingStatus === "CONFIRMED" ||
    booking.lifecycleStatus === "CONSULTATION_BOOKED"
  ) {
    if (
      booking.bookingStatus === "CONFIRMED" &&
      booking.potentialServiceName &&
      !booking.lifecycleStatus
    ) {
      booking.lifecycleStatus = "CONSULTATION_BOOKED";
    }

    booking.reminderStatus =
      booking.reminderStatus === "SENT"
        ? "SENT"
        : "SCHEDULED";
  } else {
    booking.reminderStatus = "PENDING_CLINIC_CONFIRMATION";
  }
}

function createBookingLeadId(clinic, sessionId) {
  const localDate = getClinicLocalDateParts(clinic.timezone).iso;
  const date = localDate.slice(2).replace(/-/g, "");
  const suffix = String(sessionId)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-5)
    .toUpperCase();

  return `${clinic.clinicCode}-${date}-${suffix || "LEAD"}`;
}

function findClinicService(clinic, text) {
  const lower = String(text || "").toLowerCase();

  return (clinic.services || []).find(service =>
    [service.name, ...(service.aliases || [])]
      .some(alias => lower.includes(String(alias).toLowerCase()))
  ) || null;
}


function updatePatientBookingHeuristically(sessionId, clinicId, text) {
  const clinic = getClinicConfig(clinicId);
  if (!clinic) return;

  const booking = ensurePatientBooking(sessionId, clinicId);
  const source = String(text || "");
  const lower = source.toLowerCase();

  if (!booking.leadId) {
    booking.leadId = createBookingLeadId(clinic, sessionId);
  }

  const email = source.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (email) {
    booking.email = email[0].replace(/[),.;]+$/g, "");
    if (!booking.preferredContactMethod) {
      booking.preferredContactMethod = "Email";
    }
  }

  const phone = source.match(/(\+?\d[\d\s().-]{7,}\d)/);
  if (phone) {
    const number = phone[0].trim();
    const mentionsWhatsApp = /\b(whatsapp|what'?s\s*app|wa)\b/i.test(source);
    const mentionsPhone = /\b(phone|mobile|call|telephone|contact number)\b/i.test(source);

    if (mentionsWhatsApp) {
      booking.whatsapp = number;
      booking.phone = booking.phone || number;
      booking.preferredContactMethod = "WhatsApp";
    } else {
      booking.phone = number;
      if (mentionsPhone || !booking.preferredContactMethod) {
        booking.preferredContactMethod = "Phone";
      }
    }
  }

  if (/\bprefer(?:red)?\s+(?:contact\s+by\s+)?email\b/i.test(source)) {
    booking.preferredContactMethod = "Email";
  } else if (/\bprefer(?:red)?\s+(?:contact\s+by\s+)?whatsapp\b/i.test(source)) {
    booking.preferredContactMethod = "WhatsApp";
  } else if (/\bprefer(?:red)?\s+(?:contact\s+by\s+)?(?:phone|call)\b/i.test(source)) {
    booking.preferredContactMethod = "Phone";
  }

  const nameMatch = source.match(
  /(?:my name is|i am|i'm|this is)\s+([\p{L}' -]{2,40})/iu
);

  if (nameMatch) {
    booking.patientName = nameMatch[1]
      .replace(/\b(and|my|phone|number|whatsapp|email).*/i, "")
      .trim();
  }

  const service = findClinicService(clinic, source);
  if (service) {
    booking.serviceId = service.id;
    booking.serviceName = service.name;
    booking.estimatedVisitValue =
      service.estimatedVisitValue ||
      clinic.commercialModel.defaultVisitValue;
    booking.potentialServiceName = service.potentialServiceName || "";
    booking.potentialServiceValueMin = service.potentialServiceValueMin || 0;
    booking.potentialServiceValueMax = service.potentialServiceValueMax || 0;
    booking.urgency = service.urgent ? "URGENT" : booking.urgency;
  }

  const timeMatch = source.match(
    /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i
  );
  if (timeMatch) {
    booking.preferredTime = timeMatch[0].toUpperCase();
  }

  const dateMatch = source.match(
    /\b(today|tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\b/i
  );

  if (dateMatch) {
    const resolvedDate = resolveBookingDate(
      dateMatch[0],
      clinic.timezone
    );

    if (resolvedDate) {
      booking.preferredDate = resolvedDate;
    }
  }

  if (/book|appointment|schedule|reserve|slot/i.test(source)) {
    booking.bookingStatus = "BOOKING_REQUESTED";
  }

  const hasContact =
    booking.phone ||
    booking.whatsapp ||
    booking.email;

  if (booking.patientName && hasContact) {
    booking.bookingStatus =
      booking.bookingStatus === "NEW"
        ? "CONTACT_CAPTURED"
        : booking.bookingStatus;
  }

  if (
    booking.serviceName &&
    booking.preferredDate &&
    booking.preferredTime
  ) {
    booking.bookingStatus = "AWAITING_CLINIC";
    booking.humanFollowUpNeeded = true;

  }

  refreshBookingFollowUpPlan(booking, clinic);
  booking.updatedAt = new Date().toISOString();
}

function findLatestExplicitPatientTime(sessionId) {
  const userMessages = (sessions[sessionId] || [])
    .filter(message => message.role === "user")
    .slice()
    .reverse();

  for (const message of userMessages) {
    const text = String(message.content || "");

    const twelveHour = text.match(
      /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i
    );

    if (twelveHour) {
      return twelveHour[0].toUpperCase();
    }

    const twentyFourHour = text.match(
      /\b([01]?\d|2[0-3]):([0-5]\d)\b/
    );

    if (twentyFourHour) {
      return twentyFourHour[0];
    }
  }

  return "";
}

function ensureProfile(sessionId) {
  if (!clinicProfiles[sessionId]) {
    clinicProfiles[sessionId] = {
      clinicName: "",
      city: "",
      clinicType: "",
      website: "",
      whatsapp: "",
      email: "",
      buyingIntent: ""
    };
  }
}

function updateProfileFromText(sessionId, text) {
  ensureProfile(sessionId);

  const profile = clinicProfiles[sessionId];
  const lower = text.toLowerCase();

  const emailMatch = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (emailMatch) profile.email = emailMatch[0];

  const phoneMatch = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
  if (phoneMatch) profile.whatsapp = phoneMatch[0];

  const websiteMatch = text.match(/(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.(com|ph|net|org|clinic|live)[^\s]*)/i);

if (websiteMatch) {
  const foundWebsite = websiteMatch[0]
    .trim()
    .replace(/[),.;]+$/g, "");

  const blockedWebsites = [
    "clinicnet.live",
    "eden-audit-chat.onrender.com",
    "gmail.com",
    "yahoo.com",
    "outlook.com",
    "hotmail.com",
    "protonmail.com"
  ];

  const isBlockedWebsite = blockedWebsites.some(site =>
    foundWebsite.toLowerCase().includes(site)
  );

  if (!isBlockedWebsite) {
    profile.website = foundWebsite;
    console.log("Website captured:", profile.website);
  }
}
  
  const clinicPatterns = [
/i run ([^.\n,]+)/i,
/i own ([^.\n,]+)/i,
/i manage ([^.\n,]+)/i,
/clinic[:\s]+([^.\n,]+)/i,
/clinic name ([^.\n,]+)/i,
/name ([^.\n,]+)/i,
/clinic name(?: is)? ([^.\n,]+)/i,
/from a clinic called ([^.\n,]+)/i,
/clinic called ([^.\n,]+)/i,
/called ([^.\n,]+)/i,
/i am .+? from ([^.\n,]+)/i,
/i'm .+? from ([^.\n,]+)/i,
];
    
const fbMatch =
  text.match(/our facebook page is ([^.\n,]+)/i) ||
  text.match(/facebook page is ([^.\n,]+)/i) ||
  text.match(/fb is ([^.\n,]+)/i) ||
  text.match(/fb[:\s]+([^.\n,]+)/i) ||
  text.match(/facebook[:\s]+([^.\n,]+)/i);

if (fbMatch && fbMatch[1]) {
  const fb = fbMatch[1].trim();

  const badFacebookWords = [
  "auto",
  "responder",
  "reply",
  "message limit",
  "messages",
  "follow-up",
  "manual",
  "whatsapp",
  "email",
  "unknown",
  "contact details"
];

const looksBad = badFacebookWords.some(word =>
  fb.toLowerCase().includes(word)
);

if (
  fb.length >= 3 &&
  fb.length <= 60 &&
  !looksBad
) {
  profile.facebook = fb;
}
}
  for (const pattern of clinicPatterns) {
  const match = text.match(pattern);

if (match && match[1]) {
  let candidate = match[1].trim();

  candidate = candidate
    .replace(/\bfb\b/gi, "")
    .replace(/\bfacebook\b/gi, "")
    .replace(/\bpage\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (candidate.length >= 3 && candidate.length <= 80) {
    profile.clinicName = candidate;
    break;
  }
}
  }   
  const p = clinicProfiles[sessionId];

if (p) {
  for (const key of ["clinicName", "city", "clinicType", "website", "facebook", "whatsapp", "email", "buyingIntent", "mainPainPoint"]) {
    if (typeof p[key] === "string") {
      p[key] = p[key].replace(/[;,]+$/g, "").trim();
    }
  }

  if (p.email && p.website) {
    const emailDomain = p.email.split("@")[1]?.toLowerCase();
    const websiteClean = p.website.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();

    if (emailDomain && websiteClean === emailDomain) {
      p.website = "";
    }
  }

  const typeText = `${p.clinicName || ""} ${p.clinicType || ""}`.toLowerCase();

  if (typeText.includes("dental") || typeText.includes("dentist") || typeText.includes("orthodont")) {
    p.clinicType = "Dental clinic";
  }
}
  if (lower.includes("cebu")) profile.city = "Cebu";
  if (lower.includes("manila")) profile.city = "Manila";
  if (lower.includes("davao")) profile.city = "Davao";
  if (lower.includes("makati")) profile.city = "Makati";
  if (lower.includes("quezon")) profile.city = "Quezon City";
  if (lower.includes("pattaya")) profile.city = "Pattaya";
  if (lower.includes("bangkok")) profile.city = "Bangkok";

  if (lower.includes("dental") || lower.includes("dentist")) profile.clinicType = "Dental clinic";
  if (lower.includes("aesthetic") || lower.includes("beauty")) profile.clinicType = "Aesthetic clinic";
  if (lower.includes("derma") || lower.includes("skin")) profile.clinicType = "Dermatology clinic";
  if (lower.includes("medical clinic")) profile.clinicType = "Medical clinic";

  if (
    lower.includes("interested") ||
    lower.includes("pricing") ||
    lower.includes("price") ||
    lower.includes("setup") ||
    lower.includes("start") ||
    lower.includes("help")
  ) {
    profile.buyingIntent = "Interested";
  }
}

function normalizeWebsiteUrl(url) {
  if (!url) return "";

  let clean = url.trim().replace(/[),.]+$/g, "");

  if (!/^https?:\/\//i.test(clean)) {
    clean = "https://" + clean;
  }

  return clean;
}

async function takeWebsiteScreenshot(url) {
  try {
    const accessKey = process.env.SCREENSHOT_ACCESS_KEY;

    if (!accessKey || !url) {
      return "";
    }

    return (
      "https://api.screenshotone.com/take" +
      "?access_key=" + encodeURIComponent(accessKey) +
      "&url=" + encodeURIComponent(url) +
      "&full_page=true" +
      "&viewport_width=1280" +
      "&viewport_height=1600" +
      "&format=png"
    );
  } catch (error) {
    console.error("Screenshot error:", error.message);
    return "";
  }
}

async function analyzeClinicWebsite(url) {
  try {
    
const normalizedUrl = normalizeWebsiteUrl(url);

console.log("Taking screenshot of:", normalizedUrl);

const screenshotUrl =
  await takeWebsiteScreenshot(normalizedUrl);

console.log("Screenshot URL:", screenshotUrl);

const response = await fetch(normalizedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 EdenClinicAuditBot"
      }
    });

    const html = await response.text();

    const visibleText = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12000);

    const phoneVisible =
      /(\+?\d[\d\s().-]{7,}\d)/.test(visibleText);

    const bookingCtaVisible =
      /(book|appointment|schedule|reserve|consultation|inquire|contact us|get started)/i.test(visibleText);

    const messengerWhatsappVisible =
      /(messenger|facebook\.com|m\.me|whatsapp|wa\.me)/i.test(html);

    const trustSignalsVisible =
      /(review|reviews|testimonial|testimonials|before and after|doctor|licensed|certified|years|patients|rating|award)/i.test(visibleText);

    const onlineBookingVisible =
  /(online booking|book online|schedule online|reserve online)/i.test(visibleText);

const googleMapsVisible =
  /(google maps|maps.google|directions)/i.test(html);

const reviewsVisible =
  /(review|reviews|testimonial|testimonials|rating)/i.test(visibleText);

const doctorProfileVisible =
  /(doctor|dentist|orthodontist|physician|our team|meet the doctor|meet the team)/i.test(visibleText);

const beforeAfterVisible =
  /(before and after|before\/after|gallery|results)/i.test(visibleText);

const pricingVisible =
  /(price|pricing|fees|cost|rates|packages|starts at)/i.test(visibleText);
    
    return {
  reviewedUrl: normalizedUrl,
  screenshotUrl,
  phoneVisible,
  bookingCtaVisible,
  messengerWhatsappVisible,
  trustSignalsVisible,

  onlineBookingVisible,
  googleMapsVisible,
  reviewsVisible,
  doctorProfileVisible,
  beforeAfterVisible,
  pricingVisible,

  textSample: visibleText.slice(0, 2000)
};

  } catch (error) {
    console.error("Website analysis error:", error.message);

    return {
      error: true,
      message: "Website could not be reviewed automatically."
    };
  }
}
function getProfileContext(sessionId) {
  ensureProfile(sessionId);
  const p = clinicProfiles[sessionId];

  return `
Known clinic information:
Clinic name: ${p.clinicName || "Unknown"}
City: ${p.city || "Unknown"}
Clinic type: ${p.clinicType || "Unknown"}
Website: ${p.website || "Unknown"}
Facebook: ${p.facebook || "Unknown"}
WhatsApp: ${p.whatsapp || "Unknown"}
Email: ${p.email || "Unknown"}
Buying intent: ${p.buyingIntent || "Unknown"}
`;
}

function hasLeadSignal(text) {
  const lower = text.toLowerCase();

  const hasEmail = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text);
  const hasPhone = /(\+?\d[\d\s().-]{7,}\d)/.test(text);

  const hasIntent =
    lower.includes("interested") ||
    lower.includes("useful") ||
    lower.includes("helpful") ||
    lower.includes("could work") ||
    lower.includes("could be helpful") ||
    lower.includes("tell me more") ||
    lower.includes("how does it work") ||
    lower.includes("telegram") ||
    lower.includes("after-hours") ||
    lower.includes("after hours") ||
    lower.includes("booking") ||
    lower.includes("clinicnet") ||
    lower.includes("yes") ||
    lower.includes("maybe") ||
    lower.includes("how much") ||
    lower.includes("pricing") ||
    lower.includes("price") ||
    lower.includes("setup") ||
    lower.includes("start") ||
    lower.includes("help us") ||
    lower.includes("contact") ||
    lower.includes("whatsapp") ||
    lower.includes("email");

  return hasEmail || hasPhone || hasIntent;
}

function formatTranscript(session) {
  return session
    .map(item => `${item.role.toUpperCase()}: ${item.content}`)
    .join("\n\n");
}

async function sendTelegramTo(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.error("Telegram configuration missing:", {
      hasBotToken: Boolean(TELEGRAM_BOT_TOKEN),
      chatId: chatId || "missing"
    });

    return {
      ok: false,
      error: "Telegram token or chat ID missing"
    };
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          chat_id: String(chatId).trim(),
          text: String(text).slice(0, 3900)
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      console.error(
        "Telegram API rejected message:",
        JSON.stringify(data, null, 2)
      );

      return {
        ok: false,
        status: response.status,
        data
      };
    }

    console.log(
      "Telegram message delivered:",
      chatId,
      data.result?.message_id
    );

    return {
      ok: true,
      data
    };

  } catch (error) {
    console.error(
      "Telegram delivery exception:",
      error
    );

    return {
      ok: false,
      error: error.message
    };
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram env vars missing.");
    return;
  }

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text.slice(0, 3900)
    })
  });
}

async function saveLeadToGoogleSheets({ sessionId, profileContext, summary, transcript }) {
  if (!GOOGLE_SCRIPT_URL) {
    console.log("Google Script URL missing.");
    return;
  }

  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
  sessionId,

  clinic: clinicProfiles[sessionId]?.clinicName || "",
  city: clinicProfiles[sessionId]?.city || "",
  clinicType: clinicProfiles[sessionId]?.clinicType || "",
  website: clinicProfiles[sessionId]?.website || "",
  whatsapp: clinicProfiles[sessionId]?.whatsapp || "",
  email: clinicProfiles[sessionId]?.email || "",
  intent: clinicProfiles[sessionId]?.buyingIntent || "",

  summary,
  transcript,

  timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new Error(
        `Google Sheets webhook returned ${response.status}`
      );
    }

    console.log("Lead saved to Google Sheets.");
  } catch (error) {
    console.error("Google Sheets save error:", error);
  }
}

function calculateRecoveryEstimate(transcript) {
  const text = (transcript || "").toLowerCase();

  const missedMatch = text.match(/(\d+)\s*(missed calls|missed call|calls)/i);
  const lateMatch = text.match(/(\d+)\s*(late replies|late reply|messages|inquiries|replies)/i);
  const valueMatch = text.match(/â‚±?\s?(\d{3,6})\s*(per booking|per patient|average|avg)/i);
  const conversionMatch = text.match(/(\d{1,3})\s*%/i);

  let missedCallsPerWeek = missedMatch ? Number(missedMatch[1]) : 0;
  const lateRepliesPerWeek = lateMatch ? Number(lateMatch[1]) : 0;

  const patientValue = valueMatch ? Number(valueMatch[1]) : 3500;
  const safePatientValue = patientValue > 0 ? patientValue : 3500;
  let conversionRate = conversionMatch ? Number(conversionMatch[1]) / 100 : null;

if (!missedCallsPerWeek) {
  missedCallsPerWeek = 10;
}

if (!conversionRate) {
  conversionRate = 0.3;
}
  
  let recoveredBookingsPerMonth = 0;
  let explanation = "";

  if (missedCallsPerWeek && conversionRate) {
    recoveredBookingsPerMonth = missedCallsPerWeek * conversionRate * 4;
    explanation = `Based on ${missedCallsPerWeek} missed calls per week, ${Math.round(conversionRate * 100)}% stated conversion, and â‚±${safePatientValue.toLocaleString()} average booking value.`;
  } else {
    recoveredBookingsPerMonth =
      missedCallsPerWeek * 4.3 * (1 / 3) +
      lateRepliesPerWeek * 4.3 * (1 / 5);

    explanation = `Based on a rough benchmark of recovering about 1 in 3 missed calls and 1 in 5 delayed replies, using â‚±${safePatientValue.toLocaleString()} average booking value.`;
  }

  const estimate = Math.round((recoveredBookingsPerMonth * safePatientValue) / 5000) * 5000;

  return {
    revenue: `â‚±${estimate.toLocaleString()}/month`,
    expectedOutcome: `Estimated recoverable revenue is around â‚±${estimate.toLocaleString()}/month. ${explanation}`
  };
}

async function generateAudit(profileContext, transcript, sessionId) {
    const websiteFindings = websiteFindingsBySession[sessionId];

    const websiteContext = websiteFindings && !websiteFindings.error
      ? `
Website homepage scan:
Reviewed URL: ${websiteFindings.reviewedUrl}
Phone visible: ${websiteFindings.phoneVisible ? "Yes" : "No / unclear"}
Booking CTA visible: ${websiteFindings.bookingCtaVisible ? "Yes" : "No / unclear"}
Messenger or WhatsApp visible: ${websiteFindings.messengerWhatsappVisible ? "Yes" : "No / unclear"}
Trust signals visible: ${websiteFindings.trustSignalsVisible ? "Yes" : "No / unclear"}
`
      : "";
  try {
    const prompt = `
You are Eden Clinic Network's senior clinic growth consultant.

Analyze this clinic conversation and return ONLY valid JSON.

Clinic Profile:
${profileContext}

${websiteContext}

Conversation:
${transcript}

${websiteContext}

Important:

Use information from the actual clinic conversation.

Do not use generic recommendations.

Fit Score should reflect how strongly Eden Clinic Network can help this clinic using missed-call recovery, fast follow-up, Messenger AI, booking support and revenue recovery systems.

Urgency should be HIGH, MEDIUM or LOW depending on the estimated revenue being lost.

Action Plan should be specific to the clinic's answers.

Return:

Return ONLY valid JSON:
{
  "clinicName": "SmileCare Dental Cebu",
  "score": 72,
  "revenue": "â‚±45,000 - â‚±180,000/month",

  "biggestLeak":
  "Most important revenue leak discovered from the conversation",

  "leakExplanation":
  "Brief explanation of why this leak is costing bookings or revenue",

  "fitScore":
  92,

  "expectedOutcome":
  "Estimated bookings or revenue that could realistically be recovered",

  "urgency":
  "HIGH, MEDIUM or LOW",

  "actionPlan":
  "Specific 30-day action plan based on the clinic's situation",

  "opportunity1":
  "Most valuable improvement",

  "opportunity2":
  "Second most valuable improvement",

  "opportunity3":
"Third most valuable improvement",

"websiteFindings":
"Brief homepage findings if website scan is available",

"bookingFriction":
"Brief note on website booking friction",

"trustSignals":
"Brief note on trust signals",

"responseRisk":
"Brief note on risk from slow or unclear contact options"
}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3
      })
    });

    const data = await response.json();

    const rawAudit = data.choices[0].message.content
  .replace(/```json/g, "")
  .replace(/```/g, "")
  .trim();

const audit = JSON.parse(rawAudit);

const scan = websiteFindingsBySession[sessionId];

if (scan) {
  audit.screenshotUrl = scan.screenshotUrl || "";
  
  audit.websiteFindings =
    scan.phoneVisible
      ? "Phone/contact information detected in the automated homepage scan."
      : "No visible phone number detected in the automated homepage scan.";

  audit.bookingFriction =
    [
      scan.bookingCtaVisible ? "Booking CTA detected." : "No booking CTA detected.",
      scan.onlineBookingVisible ? "Online booking option detected." : "No clear online booking option detected."
    ].join(" ");

  audit.trustSignals =
    [
      scan.trustSignalsVisible ? "General trust signals detected." : "General trust signals not detected.",
      scan.reviewsVisible ? "Reviews/testimonials detected." : "Reviews/testimonials not detected.",
      scan.doctorProfileVisible ? "Doctor/team profile detected." : "Doctor/team profile not detected.",
      scan.beforeAfterVisible ? "Before-after/gallery proof detected." : "Before-after/gallery proof not detected."
    ].join(" ");

  audit.responseRisk =
    [
      scan.messengerWhatsappVisible ? "Messenger or WhatsApp contact option detected." : "No Messenger or WhatsApp contact option detected.",
      scan.googleMapsVisible ? "Google Maps/directions link detected." : "Google Maps/directions link not detected.",
      scan.pricingVisible ? "Pricing/package information detected." : "Pricing/package information not detected."
    ].join(" ");
}
    
const recovery = calculateRecoveryEstimate(transcript);
audit.revenue = recovery.revenue;
audit.expectedOutcome = recovery.expectedOutcome;

return audit;

  } catch (error) {
    console.error("Audit generation error:", error);

    return {
  score: 50,
  revenue: "Unknown",
  biggestLeak: "Missed Calls",
  leakExplanation: "Patients may be trying to contact the clinic but not receiving a fast enough response.",
  fitScore: 70,
  expectedOutcome: "Potential recovery depends on call volume and inquiry handling.",
  urgency: "MEDIUM",
  actionPlan: "Track missed calls, improve reply speed, and add follow-up for unbooked inquiries.",
  opportunity1: "Missed Calls",
  opportunity2: "Slow Replies",
  opportunity3: "Weak Follow-Up"
};
  }
}
function safe(value, fallback = "") {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "undefined" ||
    value === "null"
  ) {
    return fallback;
  }

  return String(value);
}

function buildAuditHtml({ clinic, audit }) {
  const clinicName = safe(audit.clinicName, clinic || "Your Clinic");
  const score = safe(audit.score, "65");
  const revenue = safe(audit.revenue, "â‚±45,000 - â‚±180,000/month");
  const summary = safe(
    audit.summary,
    `${clinicName} appears to have recoverable revenue opportunities through missed calls, slow replies, and weak follow-up.`
  );

  const biggestLeak = safe(audit.biggestLeak, "Missed calls and slow replies");
  const leakExplanation = safe(
    audit.leakExplanation,
    "Patients who try to contact your clinic may not always receive a fast response, which can lead to lost bookings and missed revenue."
  );

  const expectedOutcome = safe(
    audit.expectedOutcome,
    "Potential recovery depends on call volume, inquiry volume, and how consistently the clinic follows up."
  );

  const fitScore = safe(audit.fitScore, "70");
  const urgency = safe(audit.urgency, "MEDIUM");

  const opportunity1 = safe(audit.opportunity1, "Recover missed calls faster");
  const opportunity2 = safe(audit.opportunity2, "Improve Messenger reply speed");
  const opportunity3 = safe(audit.opportunity3, "Follow up with unbooked patients");

  const websiteFindings = safe(audit.websiteFindings, "Website review not completed yet.");
  const facebookFindings = safe(audit.facebookFindings, "Facebook page review not completed yet.");
  const googleMapsFindings = safe(audit.googleMapsFindings, "Google Maps review not completed yet.");
  const reviewsScore = safe(audit.reviewsScore, "Unknown");
  const bookingFriction = safe(audit.bookingFriction, "Not enough information yet.");
  const trustSignals = safe(audit.trustSignals, "Not enough information yet.");
  const responseRisk = safe(audit.responseRisk, "Unknown");
  const screenshotUrl = safe(audit.screenshotUrl, "");
  
  return `
<!DOCTYPE html>
<html>
<head>
  <title>${clinicName} - Eden Clinic Growth Audit</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>

<body style="
font-family: Arial, sans-serif;
max-width: 900px;
margin: auto;
padding: 40px 18px;
background: #f8fafc;
color: #111827;
line-height: 1.55;
">

<div style="
background: linear-gradient(135deg, #111827, #312e81);
color:white;
padding:32px;
border-radius:22px;
margin-bottom:22px;
">

  <div style="
  font-size:13px;
  letter-spacing:0.06em;
  text-transform:uppercase;
  color:#c7d2fe;
  font-weight:bold;
  margin-bottom:8px;
  ">
  Eden Clinic Network â€¢ AI Growth Audit
  </div>

  <h1 style="
  font-size:36px;
  line-height:1.1;
  margin:0 0 8px;
  ">
  ${clinicName}
  </h1>

  <p style="
  font-size:18px;
  color:#e5e7eb;
  margin:0;
  ">
  Clinic Revenue Rescue Auditâ„¢
  </p>

</div>

<div style="
display:grid;
grid-template-columns:1fr 1fr;
gap:16px;
margin-bottom:20px;
">

  <div style="
  background:#eef4ff;
  padding:22px;
  border-radius:18px;
  ">

    <h2 style="margin-top:0;">Growth Score</h2>

    <div style="
    font-size:52px;
    font-weight:bold;
    color:#2563eb;
    ">
    ${score}/100
    </div>

  </div>

  <div style="
  background:#ecfdf5;
  padding:22px;
  border-radius:18px;
  ">

    <h2 style="margin-top:0;">Estimated Recovery Opportunity</h2>

    <div style="
    font-size:30px;
    font-weight:bold;
    color:#16a34a;
    ">
    ${revenue}
    </div>

  </div>

</div>

<div style="
background:white;
padding:24px;
border-radius:18px;
margin-bottom:18px;
border:1px solid #e5e7eb;
">

  <h2 style="margin-top:0;">Audit Summary</h2>
  <p style="font-size:18px;color:#374151;">${summary}</p>

</div>

<div style="
background:#fff7ed;
padding:24px;
border-radius:18px;
margin-bottom:18px;
border-left:7px solid #f97316;
">

  <h2 style="margin-top:0;">Biggest Revenue Leak</h2>

  <div style="
  font-size:26px;
  font-weight:bold;
  color:#c2410c;
  margin-bottom:8px;
  ">
  ${biggestLeak}
  </div>

  <p>${leakExplanation}</p>

</div>

<div style="
background:white;
padding:24px;
border-radius:18px;
margin-bottom:18px;
border:1px solid #e5e7eb;
">

  <h2 style="margin-top:0;">Eden Compatibility</h2>

  <div style="
  font-size:42px;
  font-weight:bold;
  color:#7c3aed;
  ">
  ${fitScore}/100
  </div>

  <p>
  How suitable this clinic appears for Eden's missed-call recovery,
  fast follow-up, Messenger AI, and booking support system.
  </p>

</div>

<div style="
background:#fef2f2;
padding:24px;
border-radius:18px;
border-left:7px solid #dc2626;
margin-bottom:18px;
">

  <h2 style="margin-top:0;">Priority Level</h2>

  <div style="
  font-size:30px;
  font-weight:bold;
  color:#dc2626;
  ">
  ${urgency}
  </div>

  <p>
  The sooner this clinic addresses its biggest revenue leak,
  the faster bookings and revenue can be recovered.
  </p>

</div>

<div style="
background:white;
padding:24px;
border-radius:18px;
margin-bottom:18px;
border:1px solid #e5e7eb;
">

  <h2 style="margin-top:0;">Top 3 Opportunities</h2>

  <ol style="font-size:17px;">
    <li>${opportunity1}</li>
    <li>${opportunity2}</li>
    <li>${opportunity3}</li>
  </ol>

</div>

<div style="
background:#eff6ff;
padding:24px;
border-radius:18px;
margin-bottom:18px;
">

  <h2 style="margin-top:0;">Expected Outcome</h2>

  <p style="
  font-size:22px;
  font-weight:bold;
  color:#2563eb;
  ">
  ${expectedOutcome}
  </p>

</div>

<div style="
background:white;
padding:24px;
border-radius:18px;
margin-bottom:18px;
border:1px solid #e5e7eb;
">

  <h2 style="margin-top:0;">Premium Audit Signals</h2>

  <p><strong>Website findings:</strong> ${websiteFindings}</p>
  <p><strong>Facebook findings:</strong> ${facebookFindings}</p>
  <p><strong>Google Maps findings:</strong> ${googleMapsFindings}</p>
  <p><strong>Reviews score:</strong> ${reviewsScore}</p>
  <p><strong>Booking friction:</strong> ${bookingFriction}</p>
  <p><strong>Trust signals:</strong> ${trustSignals}</p>
  <p><strong>Response risk:</strong> ${responseRisk}</p>
${screenshotUrl ? `<p><strong>Website screenshot:</strong> <a href="${screenshotUrl}" target="_blank">Open screenshot</a></p>` : ""}
</div>

<div style="
background:white;
padding:24px;
border-radius:18px;
margin-bottom:18px;
border:1px solid #e5e7eb;
">

  <h2 style="margin-top:0;">30-Day Revenue Rescue Plan</h2>

  <p><strong>Week 1:</strong> Track missed calls and slow replies.</p>
  <p><strong>Week 2:</strong> Add fast follow-up for missed inquiries.</p>
  <p><strong>Week 3:</strong> Improve Messenger and booking response flow.</p>
  <p><strong>Week 4:</strong> Review recovered bookings and revenue impact.</p>

</div>

<div style="
background:#111827;
color:white;
padding:28px;
border-radius:22px;
margin-top:28px;
">

  <h2 style="color:white;margin-top:0;">Want Eden to help recover these bookings?</h2>

  <p style="color:#e5e7eb;font-size:17px;">
  We can review your clinic setup and show which missed calls, slow replies,
  or booking leaks can be recovered first.
  </p>

  <p style="
  font-size:22px;
  font-weight:bold;
  ">
  Request your free implementation review:
  </p>

  <p style="font-size:20px;font-weight:bold;">
  clinicnet.live
  </p>

</div>

</body>
</html>
`;
}

async function createLeadSummary(session, sessionId) {
  try {
    const transcript = formatTranscript(session);
    const profileContext = getProfileContext(sessionId);

    const audit = await generateAudit(profileContext, transcript, sessionId);

console.log("Audit:", audit);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `
Create a short internal lead summary for Eden Clinic Network.

Use the known clinic information and transcript.

Return:
Clinic:
City:
Clinic type:
Contact details:
Main problems:
Estimated opportunity:
Buying intent score 1-10:
Lead temperature: HOT/WARM/COLD
Recommended follow-up:

If unknown, write Unknown.
`
          },
          {
            role: "user",
            content: profileContext + "\n\nTranscript:\n" + transcript
          }
        ]
      })
    });

    const data = await response.json();

    return (
      data.output_text ||
      data.output?.[0]?.content?.[0]?.text ||
      "Lead summary unavailable."
    ).trim();
  } catch (error) {
    console.error("Lead summary error:", error);
    return "Lead summary unavailable.";
  }
}

function createTelegramLeadCard(sessionId, summary) {
  const p = clinicProfiles[sessionId] || {};

const leadType = sessionLeadType[sessionId] || "audit";

const leadHeader =
  leadType === "receptionist"
    ? "ðŸŸ¢ NEW REVENUE RESCUE AI RECEPTIONISTâ„¢ LEAD"
    : leadType === "booking"
    ? "ðŸŸ£ NEW AI BOOKING LEAD"
    : "ðŸ”¥ NEW CLINIC AUDIT LEAD";
  
  const tempMatch = summary.match(/Lead temperature:\s*([^\n]+)/i);
  const intentMatch = summary.match(/Buying intent score 1-10:\s*([^\n]+)/i);
  const opportunityMatch = summary.match(/Estimated opportunity:\s*([\s\S]*?)(Buying intent|Lead temperature|Recommended follow-up|$)/i);
  const problemMatch = summary.match(/Main problems:\s*([\s\S]*?)(Estimated opportunity|Buying intent|Lead temperature|Recommended follow-up|$)/i);
  const followMatch = summary.match(/Recommended follow-up:\s*([\s\S]*)/i);

  const temperature = tempMatch ? tempMatch[1].trim() : "Unknown";

let intent = intentMatch ? intentMatch[1].trim() : "Unknown";
intent = intent.match(/\d+/)?.[0] || intent;
  const opportunity = opportunityMatch ? opportunityMatch[1].trim() : "Unknown";
  const problem = problemMatch ? problemMatch[1].trim() : "Unknown";
  const followUp = followMatch ? followMatch[1].trim() : "Review lead and follow up.";

  return `
${alertedSessions[sessionId] ? "ðŸ” UPDATED " + leadHeader : leadHeader}

ðŸ¥ ${p.clinicName || "Unknown clinic"}
ðŸ“ ${p.city || "Unknown city"}
ðŸ·ï¸ ${p.clinicType || "Unknown type"}
ðŸŒ¡ï¸ ${intent} of 10
${temperature}

ðŸŒ ${p.website || "No website captured"}
ðŸ“§ ${p.email || "No email captured"}
ðŸ“˜ ${p.facebook || "No Facebook captured"}
ðŸ“± ${p.whatsapp || "No WhatsApp captured"}

ðŸ’° Estimated opportunity:
${opportunity}

âš  Biggest leak:
${problem}

âž¡ Recommended next step:
${followUp}

Session:
${sessionId}
`;
}


function createBookingTelegramCard(sessionId) {
  const clinicId = sessionClinicId[sessionId] || "pearlsmile";
  const clinic = getClinicConfig(clinicId);
  const booking = ensurePatientBooking(sessionId, clinicId);

  if (!clinic) return "";

  const session = sessions[sessionId] || [];
  const isUpdate = Boolean(bookingAlertSnapshots[sessionId]);
  const latestPatientMessage = session
    .filter(item => item.role === "user")
    .slice(-1)[0]?.content || "No patient message captured";

  const estimatedFee = Math.round(
    (booking.estimatedVisitValue || clinic.commercialModel.defaultVisitValue) *
    (clinic.commercialModel.edenRate || 0)
  );

  const contact =
    booking.whatsapp ||
    booking.phone ||
    booking.email ||
    "Not captured yet";

  const contactMethod =
    booking.preferredContactMethod ||
    (booking.whatsapp
      ? "WhatsApp"
      : booking.phone
        ? "Phone"
        : booking.email
          ? "Email"
          : "Not captured yet");

  const icons = {
    updated: "\u{1F501}",
    booking: "\u{1F9B7}",
    lead: "\u{1F194}",
    patient: "\u{1F464}",
    contact: "\u{1F4F1}",
    message: "\u{1F4AC}",
    email: "\u{1F4E7}",
    date: "\u{1F4C5}",
    time: "\u{1F552}",
    status: "\u{1F4CC}",
    urgency: "\u26A1",
    money: "\u{1F4B0}",
    chart: "\u{1F4CA}",
    target: "\u{1F3AF}",
    human: "\u{1F91D}",
    channel: "\u{1F517}"
  };

  const currencySymbol =
    clinic.currency === "PHP"
      ? "\u20B1"
      : clinic.currencySymbol;

  const potentialText = booking.potentialServiceName
    ? `\n${icons.target} Potential service: ${booking.potentialServiceName}\nPotential range: ${currencySymbol}${booking.potentialServiceValueMin.toLocaleString()}-${currencySymbol}${booking.potentialServiceValueMax.toLocaleString()}`
    : "";

  const edenFeeText = booking.potentialServiceName
    ? `${icons.chart} Eden fee: Pending treatment and revenue confirmation`
    : `${icons.chart} Indicative Eden fee (${Math.round((clinic.commercialModel.edenRate || 0) * 100)}%): ${currencySymbol}${estimatedFee.toLocaleString()}`;

  return `
${isUpdate ? icons.updated + " UPDATED PATIENT BOOKING" : icons.booking + " NEW PATIENT BOOKING"} - ${clinic.clinicName.toUpperCase()}

${icons.lead} Lead: ${booking.leadId}
${icons.patient} Patient: ${booking.patientName || "Not captured yet"}
${icons.contact} Phone: ${booking.phone || "Not captured yet"}
${icons.message} WhatsApp: ${booking.whatsapp || "Not captured yet"}
${icons.email} Email: ${booking.email || "Not captured yet"}
${icons.channel} Preferred contact: ${contactMethod}

${icons.booking} Service: ${booking.serviceName || "Not identified yet"}
${icons.date} Requested date: ${booking.preferredDate || "Not captured yet"}
${icons.time} Requested time: ${booking.preferredTime || "Not captured yet"}
${icons.status} Status: ${booking.bookingStatus}
${icons.status} Lifecycle: ${booking.lifecycleStatus || "Not started"}
${icons.human} Attendance: ${booking.attendanceStatus}
${icons.urgency} Urgency: ${booking.urgency}

${icons.money} Observable visit value: ${currencySymbol}${(booking.estimatedVisitValue || clinic.commercialModel.defaultVisitValue).toLocaleString()}
${edenFeeText}${potentialText}

${icons.message} Latest patient message:
${latestPatientMessage}

${icons.human} Human follow-up: ${booking.humanFollowUpNeeded ? "Needed" : "Not yet required"}
${icons.channel} Channel: ${clinic.googleSheets?.channelLabel || "Website AI booking chat"}

Session: ${sessionId}
`.trim();
}

async function extractPatientBookingWithAI(sessionId) {
  try {
    const clinicId = sessionClinicId[sessionId] || "pearlsmile";
    const clinic = getClinicConfig(clinicId);
    if (!clinic) return;

    const booking = ensurePatientBooking(sessionId, clinicId);
    const recentMessages = (sessions[sessionId] || []).slice(-12);
    if (!recentMessages.length) return;

    const allowedServices = (clinic.services || [])
      .map(service => ({ id: service.id, name: service.name }))
      .map(item => JSON.stringify(item))
      .join(", ");

    const clinicToday =
      getClinicLocalDateParts(clinic.timezone).iso;

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                `Extract patient booking information. Return JSON only. Do not guess.\n` +
                `Clinic timezone: ${clinic.timezone}\n` +
                `Current clinic date: ${clinicToday}\n` +
                `Allowed services: ${allowedServices}\n` +
                `Fields: patientName, phone, whatsapp, email, preferredContactMethod, serviceId, serviceName, preferredDate, preferredTime, bookingStatus, urgency, summary.\n` +
                `preferredContactMethod must be Phone, WhatsApp, Email, or empty.\n` +
                `For preferredDate, preserve relative words such as today or tomorrow if used; otherwise use YYYY-MM-DD. Never return a date before ${clinicToday}.\n` +
                `For preferredTime, use the patient's latest explicit selection or acceptance. Never silently substitute a clinic slot and never replace it with an earlier time mentioned in the conversation.\n` +
                `bookingStatus must be one of NEW, CONTACT_CAPTURED, BOOKING_REQUESTED, AWAITING_CLINIC. urgency must be NORMAL or URGENT.`
            },
            {
              role: "user",
              content: JSON.stringify(recentMessages)
            }
          ]
        })
      }
    );

    if (!response.ok) return;

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "{}";
    const extracted = JSON.parse(raw);

    for (const key of [
      "patientName",
      "phone",
      "whatsapp",
      "email",
      "preferredTime",
      "summary"
    ]) {
      if (
        typeof extracted[key] === "string" &&
        extracted[key].trim()
      ) {
        booking[key] = extracted[key].trim();
      }
    }

    if (
      ["Phone", "WhatsApp", "Email"].includes(
        extracted.preferredContactMethod
      )
    ) {
      booking.preferredContactMethod =
        extracted.preferredContactMethod;
    }

    const latestExplicitPatientTime =
      findLatestExplicitPatientTime(sessionId);

    if (latestExplicitPatientTime) {
      booking.preferredTime = latestExplicitPatientTime;
    }

    if (
      typeof extracted.preferredDate === "string" &&
      extracted.preferredDate.trim()
    ) {
      const resolvedDate = resolveBookingDate(
        extracted.preferredDate.trim(),
        clinic.timezone
      );

      if (resolvedDate) {
        booking.preferredDate = resolvedDate;
      }
    }

    if (
      ["NEW", "CONTACT_CAPTURED", "BOOKING_REQUESTED", "AWAITING_CLINIC"]
        .includes(extracted.bookingStatus)
    ) {
      booking.bookingStatus = extracted.bookingStatus;
    }

    if (["NORMAL", "URGENT"].includes(extracted.urgency)) {
      booking.urgency = extracted.urgency;
    }

    const service = (clinic.services || []).find(item =>
      item.id === extracted.serviceId ||
      item.name.toLowerCase() ===
        String(extracted.serviceName || "").toLowerCase()
    );

    if (service) {
      booking.serviceId = service.id;
      booking.serviceName = service.name;
      booking.estimatedVisitValue =
        service.estimatedVisitValue ||
        clinic.commercialModel.defaultVisitValue;
      booking.potentialServiceName =
        service.potentialServiceName || "";
      booking.potentialServiceValueMin =
        service.potentialServiceValueMin || 0;
      booking.potentialServiceValueMax =
        service.potentialServiceValueMax || 0;

      if (service.urgent) {
        booking.urgency = "URGENT";
      }
    }

    if (booking.whatsapp && !booking.phone) {
      booking.phone = booking.whatsapp;
    }

    if (!booking.preferredContactMethod) {
      booking.preferredContactMethod =
        booking.whatsapp
          ? "WhatsApp"
          : booking.phone
            ? "Phone"
            : booking.email
              ? "Email"
              : "";
    }

    const hasContact =
      booking.phone ||
      booking.whatsapp ||
      booking.email;

    if (
      booking.patientName &&
      hasContact &&
      booking.bookingStatus === "NEW"
    ) {
      booking.bookingStatus = "CONTACT_CAPTURED";
    }

    if (
      booking.serviceName &&
      booking.preferredDate &&
      booking.preferredTime
    ) {
      booking.bookingStatus = "AWAITING_CLINIC";

    }

    booking.humanFollowUpNeeded =
      booking.bookingStatus === "AWAITING_CLINIC";

    refreshBookingFollowUpPlan(booking, clinic);
    booking.updatedAt = new Date().toISOString();
  } catch (error) {
    console.error(
      "Patient booking extraction error:",
      error.message
    );
  }
}


async function saveBookingToGoogleSheets(sessionId) {
  if (!GOOGLE_SCRIPT_URL) return;

  const clinicId = sessionClinicId[sessionId] || "pearlsmile";
  const clinic = getClinicConfig(clinicId);
  const booking = ensurePatientBooking(sessionId, clinicId);
  if (!clinic) return;

  const contact =
    booking.whatsapp ||
    booking.phone ||
    booking.email ||
    "";

  const contactMethod =
    booking.preferredContactMethod ||
    (booking.whatsapp
      ? "WhatsApp"
      : booking.phone
        ? "Phone"
        : booking.email
          ? "Email"
          : "");

  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recordType: "PATIENT_BOOKING",
        source: booking.source || "AI_CHAT",
        timestamp: new Date().toISOString(),
        created: booking.createdAt,
        updated: booking.updatedAt,
        leadId: booking.leadId,
        sessionId,
        clinicId,
        clinic: clinic.clinicName,
        channel:
          clinic.googleSheets?.channelLabel ||
          "Website AI booking chat",
        patientName: booking.patientName,
        contact,
        contactMethod,
        phone: booking.phone,
        whatsapp: booking.whatsapp,
        email: booking.email,
        service: booking.serviceName,
        potentialService: booking.potentialServiceName,
        potentialServiceValueMin:
          booking.potentialServiceValueMin || 0,
        potentialServiceValueMax:
          booking.potentialServiceValueMax || 0,
        requestedDate: booking.preferredDate,
        requestedTime: booking.preferredTime,
        status: booking.bookingStatus,
        lifecycleStatus: booking.lifecycleStatus,
        reminderStatus: booking.reminderStatus,
        reminderDueAt: booking.reminderDueAt,
        attendanceCheckDueAt:
          booking.attendanceCheckDueAt,
        attendanceStatus: booking.attendanceStatus,
        treatmentDecisionCheckDueAt:
          booking.treatmentDecisionCheckDueAt,
        lastPatientReply: booking.lastPatientReply,
        reminderMessage: booking.reminderMessage,
        attendanceMessage: booking.attendanceMessage,
        urgency: booking.urgency,
        estimatedVisitValue:
          booking.estimatedVisitValue ||
          clinic.commercialModel.defaultVisitValue,
        edenRate: clinic.commercialModel.edenRate,
        estimatedEdenFee:
          booking.potentialServiceName
            ? ""
            : Math.round(
                (
                  booking.estimatedVisitValue ||
                  clinic.commercialModel.defaultVisitValue
                ) * clinic.commercialModel.edenRate
              ),
        humanFollowUpNeeded:
          booking.humanFollowUpNeeded
            ? "Yes"
            : "No",
        humanTeamUsed:
          booking.humanTeamUsed
            ? "Yes"
            : "No",
        telegramSent: "Yes",
        summary: booking.summary || "",
        transcript:
          formatTranscript(
            sessions[sessionId] || []
          )
      })
    });

    if (!response.ok) {
      throw new Error(
        `Google Sheets webhook returned ${response.status}`
      );
    }
  } catch (error) {
    console.error(
      "Booking Google Sheets save error:",
      error.message
    );
  }
}

async function saveMissedCallToGoogleSheets({
  clinic,
  clinicId,
  caller,
  callSid,
  callStatus,
  callDuration,
  transcript,
  summary
}) {
  if (!GOOGLE_SCRIPT_URL || !clinic) return;

  const stableCallId =
    callSid ||
    `${clinic.clinicCode}-CALL-${Date.now()}`;

  const leadId = String(stableCallId).startsWith(
    `${clinic.clinicCode}-`
  )
    ? String(stableCallId)
    : `${clinic.clinicCode}-CALL-${String(stableCallId)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(-10)
        .toUpperCase()}`;

  const response = await fetch(GOOGLE_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recordType: "MISSED_CALL",
      source: "MISSED_CALL",
      timestamp: new Date().toISOString(),
      updated: new Date().toISOString(),
      leadId,
      sessionId: callSid || stableCallId,
      clinicId,
      clinic: clinic.clinicName,
      channel: "Missed call recovery",
      phone: caller || "",
      contact: caller || "",
      contactMethod: "Phone",
      status: callStatus || "MISSED_CALL",
      humanFollowUpNeeded: "Yes",
      humanTeamUsed: "No",
      telegramSent: "Yes",
      summary: summary || "Missed call requires clinic follow-up.",
      transcript: transcript || "",
      callSid: callSid || "",
      callStatus: callStatus || "MISSED_CALL",
      callDuration: callDuration || ""
    })
  });

  if (!response.ok) {
    throw new Error(
      `Google Sheets webhook returned ${response.status}`
    );
  }
}

function applyBookingFollowUpReply(booking, stage, rawReply) {
  const reply = String(rawReply || "").trim();
  booking.lastPatientReply = reply;

  if (stage === "reminder") {
    if (reply === "1") {
      booking.bookingStatus = "CONFIRMED";
      booking.reminderStatus = "CONFIRMED_BY_PATIENT";
      return "CONFIRMED";
    }

    if (reply === "2") {
      booking.bookingStatus = "RESCHEDULE_REQUESTED";
      booking.reminderStatus = "RESCHEDULE_REQUESTED";
      booking.humanFollowUpNeeded = true;
      return "RESCHEDULE_REQUESTED";
    }
  }

  if (stage === "attendance") {
    if (reply === "1") {
      booking.attendanceStatus = "ATTENDED";

      if (booking.potentialServiceName) {
        booking.lifecycleStatus = "CONSULTATION_ATTENDED";
      }

      return "ATTENDED";
    }

    if (reply === "2") {
      booking.attendanceStatus = "DID_NOT_ATTEND";
      booking.humanFollowUpNeeded = true;
      return "DID_NOT_ATTEND";
    }
  }

  if (stage === "treatment") {
    const treatmentStatuses = {
      "1": "TREATMENT_STARTED",
      "2": "PLANNING_TO_START",
      "3": "PATIENT_HAS_QUESTION",
      "4": "NOT_PROCEEDING"
    };

    if (treatmentStatuses[reply]) {
      booking.lifecycleStatus = treatmentStatuses[reply];
      booking.humanFollowUpNeeded = ["2", "3"].includes(reply);
      return treatmentStatuses[reply];
    }
  }

  return "INVALID_REPLY";
}

async function maybeSendBookingAlert(sessionId, latestUserText) {
  const clinicId = sessionClinicId[sessionId] || "pearlsmile";
  const clinic = getClinicConfig(clinicId);
  if (!clinic) return;

  updatePatientBookingHeuristically(sessionId, clinicId, latestUserText);
  await extractPatientBookingWithAI(sessionId);

  const booking = ensurePatientBooking(sessionId, clinicId);
  const bookingSignal =
    hasLeadSignal(latestUserText) ||
    /book|appointment|schedule|available|slot|cleaning|whitening|implant|braces|pain|consultation|tooth|dental/i.test(latestUserText);

  if (!bookingSignal && !bookingAlertSnapshots[sessionId]) return;

  const importantSnapshot = [
    booking.patientName,
    booking.phone,
    booking.whatsapp,
    booking.email,
    booking.preferredContactMethod,
    booking.serviceId,
    booking.preferredDate,
    booking.preferredTime,
    booking.bookingStatus,
    booking.lifecycleStatus,
    booking.reminderStatus,
    booking.attendanceStatus,
    booking.urgency
  ].join("|");

  if (bookingAlertSnapshots[sessionId] === importantSnapshot) return;

  const telegramChatId = clinic.telegram?.bookingChatId;
  if (!telegramChatId) {
    console.warn("Booking Telegram chat ID missing for:", clinic.clinicName);
    return;
  }

  const message = createBookingTelegramCard(sessionId);
  if (!message) return;

  await sendTelegramTo(telegramChatId, message);
  bookingAlertSnapshots[sessionId] = importantSnapshot;
  await saveBookingToGoogleSheets(sessionId);

  console.log("Booking alert sent:", clinic.clinicName, sessionId);
}

async function sharedLeadPipeline(
  sessionId,
  latestUserText
) {
  if (!sessions[sessionId]) return;

  const leadType =
    sessionLeadType[sessionId] ||
    "audit";

  /*
  PATIENT BOOKING PIPELINE

  Booking conversations go to the clinic's
  dedicated Telegram group and do not enter
  Eden's acquisition-alert pipeline.
  */
  if (leadType === "booking") {
    try {
      await maybeSendBookingAlert(
        sessionId,
        latestUserText
      );
    } catch (error) {
      console.error(
        "Booking alert pipeline error:",
        error
      );
    }

    return;
  }

  /*
  EDEN ACQUISITION PIPELINE

  Clinic Audit and AI Receptionist acquisition
  leads continue using the existing pipeline.
  */
  if (sessions[sessionId].length % 6 === 0) {
    try {
      await extractProfileWithAI(
        sessionId
      );
    } catch (error) {
      console.error(
        "Profile extraction:",
        error
      );
    }
  }

  try {
    await maybeSendLeadAlert(
      sessionId,
      latestUserText
    );
  } catch (error) {
    console.error(
      "Lead pipeline:",
      error
    );
  }
}

async function maybeSendLeadAlert(sessionId, latestUserText) {
  const profile = clinicProfiles[sessionId] || {};

  if (!hasLeadSignal(latestUserText)) return;

  const session = sessions[sessionId] || [];
  const summary = await createLeadSummary(session, sessionId);
  
  updateProfileFromText(sessionId, summary);

  const updatedProfile = clinicProfiles[sessionId] || {};

const alertSnapshot = [
  updatedProfile.clinicName,
  updatedProfile.city,
  updatedProfile.clinicType,
  updatedProfile.website,
  updatedProfile.facebook,
  updatedProfile.whatsapp,
  updatedProfile.email,
  updatedProfile.buyingIntent,
  updatedProfile.mainPainPoint
].join("|");

const hasImportantUpdate =
  updatedProfile.email ||
  updatedProfile.whatsapp ||
  updatedProfile.website ||
  updatedProfile.facebook ||
  updatedProfile.buyingIntent === "high";

if (leadAlertSnapshots[sessionId] === alertSnapshot) return;

if (alertedSessions[sessionId] && !hasImportantUpdate) return;
  const transcript = formatTranscript(session);
  const profileContext = getProfileContext(sessionId);
const audit = await generateAudit(profileContext, transcript, sessionId);
auditPreviewHtmlBySession[sessionId] = buildAuditHtml({
  clinic: profile.clinicName || "Your Clinic",
  audit
});
const message = createTelegramLeadCard(sessionId, summary);
  
  await saveLeadToGoogleSheets({
  sessionId,
  profileContext,
  summary,
  transcript
});
  
  await sendTelegram(message);
  if (hasImportantUpdate) {
  contactUpdatedSessions[sessionId] = true;
}

leadAlertSnapshots[sessionId] = alertSnapshot;
alertedSessions[sessionId] = true;
}

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

      const aiReply = await getAIReply(userText, senderId);
      await sendMessage(senderId, aiReply);
    }
  } catch (error) {
    console.error("Webhook error:", error);
  }

  res.sendStatus(200);
});

async function getAIReply(userText, sessionId = "default", systemPrompt = SYSTEM_PROMPT) {
  try {
    if (!sessions[sessionId]) {
      sessions[sessionId] = [];
    }

    ensureProfile(sessionId);
    updateProfileFromText(sessionId, userText);

const currentProfile = clinicProfiles[sessionId];

if (
  currentProfile?.website &&
  !websiteFindingsBySession[sessionId]
) {
  console.log("Running website scan for:", currentProfile.website);

  websiteFindingsBySession[sessionId] =
    await analyzeClinicWebsite(currentProfile.website);

  console.log("Website scan result:", websiteFindingsBySession[sessionId]);
}
    
    sessions[sessionId].push({
      role: "user",
      content: userText
    });

    sessions[sessionId] = sessions[sessionId].slice(-50);

    const profileContext = getProfileContext(sessionId);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: systemPrompt + "\n\n" + profileContext
          },
          ...sessions[sessionId]
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
      reply = "Got you ðŸ˜Š what would you like help with?";
    }

    sessions[sessionId].push({
      role: "assistant",
      content: reply
    });

    sessions[sessionId] = sessions[sessionId].slice(-50);

    await sharedLeadPipeline(sessionId, userText);

    return reply.trim();
  } catch (error) {
    console.error("OpenAI error:", error);
    return "One sec ðŸ˜Š let me check that for you.";
  }
}

async function sendMessage(senderId, text) {
  if (!text || text.trim() === "") {
    text = "Hi ðŸ˜Š how can I help you today?";
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

app.post("/booking-followup-response", async (req, res) => {
  try {
    const sessionId = String(req.body.sessionId || "").trim();
    const stage = String(req.body.stage || "").trim().toLowerCase();
    const reply = String(req.body.reply || "").trim();

    if (!sessionId || !["reminder", "attendance", "treatment"].includes(stage)) {
      return res.status(400).json({
        success: false,
        error: "sessionId and a valid stage are required"
      });
    }

    const clinicId =
      sessionClinicId[sessionId] ||
      req.body.clinicId ||
      "pearlsmile";

    const clinic = getClinicConfig(clinicId);
    const booking = patientBookings[sessionId];

    if (!clinic || !booking) {
      return res.status(404).json({
        success: false,
        error: "Booking session not found"
      });
    }

    const result = applyBookingFollowUpReply(
      booking,
      stage,
      reply
    );

    if (result === "INVALID_REPLY") {
      return res.status(400).json({
        success: false,
        result,
        replyMessage: "Please reply with one of the listed numbers."
      });
    }

    booking.updatedAt = new Date().toISOString();
    refreshBookingFollowUpPlan(booking, clinic);
    await saveBookingToGoogleSheets(sessionId);

    const telegramChatId = clinic.telegram?.bookingChatId;
    if (telegramChatId) {
      await sendTelegramTo(
        telegramChatId,
        createBookingTelegramCard(sessionId)
      );
    }

    return res.json({
      success: true,
      result,
      bookingStatus: booking.bookingStatus,
      lifecycleStatus: booking.lifecycleStatus,
      attendanceStatus: booking.attendanceStatus
    });
  } catch (error) {
    console.error("Booking follow-up response error:", error);
    return res.status(500).json({
      success: false,
      error: "Unable to process follow-up response"
    });
  }
});

app.post("/eleven-postcall", async (req, res) => {
  try {
    const data = req.body;

    const clinicId =
      data.clinicId ||
      data.clinic_id ||
      "pearlsmile";

    const clinic =
      getClinicConfig(clinicId) ||
      getClinicConfig("pearlsmile");

    const transcript =
      data.transcript ||
      data.conversation_transcript ||
      JSON.stringify(data, null, 2);

    const caller =
      data.caller_id ||
      data.phone_number ||
      data.from ||
      "Unknown";

    const callSid =
      data.call_sid ||
      data.callSid ||
      data.conversation_id ||
      "";

    const callStatus =
      data.call_status ||
      data.status ||
      "MISSED_CALL";

    const callDuration =
      data.call_duration ||
      data.duration ||
      "";

    const message = `
\u{1F4DE} MISSED CALL / AI CALL UPDATE

Clinic: ${clinic.clinicName}
Source: MISSED_CALL
Status: ${callStatus}

\u{1F4F1} Caller: ${caller}

\u{1F4DD} Transcript:
${transcript.slice(0, 3000)}
`;

    const telegramChatId = clinic.telegram?.bookingChatId;

    if (telegramChatId) {
      await sendTelegramTo(telegramChatId, message);
    } else {
      await sendTelegram(message);
    }

    await saveMissedCallToGoogleSheets({
      clinic,
      clinicId: clinic.clinicId,
      caller,
      callSid,
      callStatus,
      callDuration,
      transcript,
      summary: "Missed call or completed AI call requires clinic review."
    });

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

app.get(
  "/test-booking-telegram/:clinicId",
  async (req, res) => {
    try {
      const clinic =
        getClinicConfig(req.params.clinicId);

      if (!clinic) {
        return res
          .status(404)
          .send("Unknown clinic");
      }

      const bookingChatId =
        clinic.telegram?.bookingChatId;

      if (!bookingChatId) {
        return res
          .status(400)
          .send(
            "Booking chat ID missing from Render environment"
          );
      }

      const result =
        await sendTelegramTo(
          bookingChatId,
          `PearlSmile Telegram test

Clinic: ${clinic.clinicName}
Assistant: ${clinic.assistantName}
Time: ${new Date().toISOString()}`
        );

      if (!result?.ok) {
        return res.status(500).json({
          success: false,
          clinic: clinic.clinicName,
          chatIdDetected: Boolean(bookingChatId),
          telegramResult: result
        });
      }

      return res.json({
        success: true,
        message:
          `${clinic.clinicName} booking Telegram test delivered`,
        telegramMessageId:
          result.data?.result?.message_id
      });

    } catch (error) {
      console.error(
        "Booking Telegram test error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

app.get("/test-telegram", async (req, res) => {
  try {
    await sendTelegram("âœ… Eden Telegram test alert works.");
    res.send("Telegram test sent");
  } catch (err) {
    console.error("Telegram test error:", err);
    res.status(500).send("Telegram test failed");
  }
});

async function extractProfileWithAI(sessionId) {
  try {
    const history = sessions[sessionId] || [];
    const recentMessages = history.slice(-12);

    if (recentMessages.length < 4) return;

    const profile = clinicProfiles[sessionId] || {};

    const extractionPrompt = `
Extract clinic lead information from this chat.

Return ONLY valid JSON.
No markdown.
No explanation.

Fields:
{
  "clinicName": "",
  "personName": "",
  "city": "",
  "clinicType": "",
  "website": "",
  "facebook": "",
  "whatsapp": "",
  "email": "",
  "buyingIntent": "",
  "mainPainPoint": ""
}

Rules:
- Use empty string if unknown.
- Do not guess.
- buyingIntent can be: low, medium, high, or empty.
- mainPainPoint should be short.
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: extractionPrompt },
          { role: "user", content: JSON.stringify(recentMessages) }
        ]
      })
    });

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "{}";

    const extracted = JSON.parse(raw);

    clinicProfiles[sessionId] = {
      ...profile,
      ...Object.fromEntries(
        Object.entries(extracted).filter(([key, value]) => value && value.trim() !== "")
      )
    };

    console.log("AI profile extracted:", sessionId, clinicProfiles[sessionId]);

  } catch (error) {
    console.error("AI profile extraction error:", error.message);
  }
}

app.post("/chat", async (req, res) => {
  try {
    const userText = req.body.message || "";
    const sessionId = req.body.sessionId || "website-default";

sessionLeadType[sessionId] = "audit";
    
    if (!userText.trim()) {
      return res.json({ reply: "Hi ðŸ˜Š What is your clinic name and website?" });
    }

    const reply = await getAIReply(userText, sessionId);
    res.json({
  reply,
  sessionId,
  auditPreviewUrl: `https://eden-audit-chat.onrender.com/audit-preview/${sessionId}`
});
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ reply: "One sec ðŸ˜Š let me check that for you." });
  }
});

app.post("/booking-chat", async (req, res) => {
  try {
    const userText = req.body.message || "";

    const sessionId =
      req.body.sessionId ||
      `booking_${Date.now()}`;

    const clinicId =
      req.body.clinicId ||
      "pearlsmile";

    const clinic =
      getClinicConfig(clinicId);

    if (!clinic) {
      console.warn(
        "Unknown clinicId received:",
        clinicId
      );

      return res.status(400).json({
        reply:
          "Sorry, this clinic is not configured yet.",
        sessionId,
        clinicId
      });
    }

    sessionLeadType[sessionId] = "booking";
    sessionClinicId[sessionId] = clinicId;
    
    if (!userText.trim()) {
      return res.json({
        reply:
          `Hi ðŸ˜Š Welcome to ${clinic.clinicName}. ` +
          `Iâ€™m ${clinic.assistantName}. How can I help you today?`,

        sessionId,
        clinicId,
        clinicName: clinic.clinicName
      });
    }

    ensurePatientBooking(sessionId, clinicId);
    updatePatientBookingHeuristically(sessionId, clinicId, userText);

    const clinicBookingPrompt = buildClinicBookingPrompt(clinic);

    const reply = await getAIReply(
      userText,
      sessionId,
      clinicBookingPrompt
    );

    res.json({
      reply,
      sessionId,
      clinicId,
      clinicName: clinic.clinicName,
      assistantName: clinic.assistantName
    });

  } catch (error) {
    console.error(
      "Booking chat error:",
      error
    );

    res.status(500).json({
      reply:
        "One sec ðŸ˜Š let me check that for you."
    });
  }
});

app.post("/revenue-receptionist-chat", async (req, res) => {
  try {
    const userText = req.body.message || "";
    const sessionId = req.body.sessionId || `revenue_${Date.now()}`;
    
sessionLeadType[sessionId] = "receptionist";
    
    if (!userText.trim()) {
      return res.json({
        reply:
          "Hi ðŸ‘‹ Many clinics lose bookings simply because patients donâ€™t receive a fast reply.\n\nIâ€™d be happy to see whether your clinic qualifies for a free AI Receptionist.\n\nWhat clinic do you run?",
        sessionId
      });
    }

    const reply = await getAIReply(
      userText,
      sessionId,
      RECEPTIONIST_SYSTEM_PROMPT
    );

    res.json({
      reply,
      sessionId
    });

  } catch (error) {
    console.error("Revenue receptionist chat error:", error);
    res.status(500).json({
      reply: "One sec ðŸ˜Š let me check that for you."
    });
  }
});

app.get("/audit-preview/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    if (auditPreviewHtmlBySession[sessionId]) {
  return res.send(auditPreviewHtmlBySession[sessionId]);
    }
    if (!sessions[sessionId] || sessions[sessionId].length === 0) {
  return res.send(buildAuditHtml({
    clinic: "Audit not ready yet",
    audit: {
      clinicName: "Audit not ready yet",
      score: 0,
      revenue: "Waiting for clinic conversation",
      summary: "Please complete the clinic audit chat first. Eden needs the actual clinic conversation before generating a useful preview.",
      biggestLeak: "Not enough information yet",
      leakExplanation: "No clinic conversation was found for this audit preview link.",
      fitScore: 0,
      expectedOutcome: "Waiting for clinic conversation",
      urgency: "LOW",
      opportunity1: "Complete the audit chat",
      opportunity2: "Share clinic name and city",
      opportunity3: "Share how bookings and inquiries are handled"
    }
  }));
}
    const session = sessions[sessionId] || [];
    const transcript = formatTranscript(session);
    const profileContext = getProfileContext(sessionId);
    const profile = clinicProfiles[sessionId] || {};    
    const audit = await generateAudit(profileContext, transcript, sessionId);

    const html = buildAuditHtml({
      clinic:
  profile.clinicName ||
  sessions[sessionId]?.find(m => m.role === "user")?.content?.match(/my clinic is ([^.\n]+)/i)?.[1] ||
  "Your Clinic",
      audit
    });

    res.send(html);
  } catch (error) {
    console.error("Audit preview error:", error);
    res.status(500).send("Audit preview unavailable.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
