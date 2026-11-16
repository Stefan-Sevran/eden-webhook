const { createHmac } = require("node:crypto");
const { createMessengerProcessor } = require("./messenger-events");
const { outcomeKey } = require("./outcome-ledger");
const { isUuid } = require("./clinic-tenant");

const day = 24 * 60 * 60 * 1000;
const recentExchangeLimit = 8;
const referenceWindow = 30 * day;
const recentConversationLimit = 500;
const pageNumber = /^\d{5,30}$/;
const fallback = {
  intent: "handoff", service: "", requestedTime: "",
  reply: "I’ll ask the clinic team to help here. They’ll follow up as soon as they can."
};

const conversationalStyle = `Answer the visitor's actual question first, especially if they repeat or correct something. Match their pace and tone. Write like a warm, relaxed clinic receptionist in Messenger: usually one to three short sentences, ordinary words and contractions, varied openings, and at most one light emoji when it fits. Skip emoji for serious concerns. With Tagalog or Cebuano speakers, mirror their language and use local words naturally. Be clear that you are an AI assistant if asked.
Stay curious when the visitor is exploring. Acknowledge worries about pain, cost, or a visit in their own terms. Use a short, genuine line such as ‘We can take it at your pace.’ Skip stock openings such as ‘I completely understand’ or ‘just to let you know.’ Answer what you can. Offer one helpful, low-pressure next step when appropriate. Give the approved price or range if asked and explain any conditions without making up fees, availability, coverage, or results. Consider a consultation when the visitor wants help deciding and the clinic offers one. A simple thank-you, decline, or request to wait can end the turn without a question.
Once they want to request an appointment, pick up from the last detail they gave. Ask only for the next missing detail: service, preferred date, or exact time. If they give a window like Thursday afternoon, ask what time that afternoon works. After a time like 3:15 without AM or PM, clarify if ambiguous. Respect a clearly flexible preference. Don't repeat a booking invitation or ask for a phone number when staff can follow up in Messenger. An acknowledgement alone does not start a booking. An affirmative reply to a clear request offer can count as consent when the required details are already known.`;

const weekdays = ["Sunday|Sun|Linggo|Domingo", "Monday|Mon|Lunes", "Tuesday|Tue|Tues|Martes",
  "Wednesday|Wed|Miyerkules", "Thursday|Thrusday|Thu|Thurs|Huwebes", "Friday|Fri|Biyernes", "Saturday|Sat|Sabado"];
const weekdayNames = weekdays.join("|");
const monthNames = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const dayOfMonth = "(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?";
const dateWithMonth = "(?:(?:" + monthNames + ")\\s+" + dayOfMonth + "|" + dayOfMonth + "\\s+(?:" + monthNames + "))(?:,?\\s+\\d{4})?";
const dayPattern = "(?:(?:(?:" + weekdayNames + "),?\\s+)?" + dateWithMonth +
  "|(?:this\\s+|next\\s+)?(?:" + weekdayNames + ")" +
  "|today|tomorrow|karon|ugma|ngayon|bukas|\\d{4}-\\d{2}-\\d{2})";
const clockPattern = "(?:(?:0?[1-9]|1[0-2])(?::[0-5]\\d)?\\s*[ap]\\.?m\\.?|(?:0\\d|1\\d|2[0-3]):[0-5]\\d|noon|midnight)";
const dayPreference = new RegExp("^" + dayPattern + "$", "i");
const clockPreference = new RegExp("^" + clockPattern + "$", "i");
const completePreference = new RegExp("\\b(" + dayPattern + ")\\s+(?:at\\s+)?(" + clockPattern + ")(?![\\w:])", "gi");
const deferring = /^(?:no thanks|not now|maybe later|just looking|just checking|i(?:['’]ll| will) think about it)[.!…\s]*$/i;
const flexiblePreference = /^(?:i(?:['’]m| am) flexible|(?:i am )?flexible|any\s+(?:day|time)(?:\s+works)?|anytime(?:\s+works)?|whenever(?:\s+works)?|kahit kailan|bisan kanus-a)$/i;

const dayMention = new RegExp("\\b(" + dayPattern + ")(?![\\w-])", "gi");
const clockMention = new RegExp("(?<![\\w:])" + clockPattern + "(?![\\w:])", "i");
const statedEarlier = "(?:i already (?:mentioned|said)\\s+)?";
const statedDay = new RegExp("^" + statedEarlier + "(" + dayPattern + ")[.!?\\s]*$", "i");
const statedClock = new RegExp("^" + statedEarlier + "(?:at\\s+)?(" + clockPattern +
  ")(?:\\s+((?:cebu|manila|philippine|ph) time))?(?:\\s+(?:please|ok(?:ay)?))?[.!?\\s]*$", "i");
const secondBooking = /\b(?:another|a second|an additional|a separate)\s+(?:appointment|booking|visit)\b/i;
const confirmedNewRequest = "new_booking";
const changeActions = new Set(["change_time", "change_service", "cancel"]);
const followupTitles = {
  change_time: "Messenger request to change appointment time",
  change_service: "Messenger request to change service",
  cancel: "Messenger cancellation requested",
  follow_up: "Messenger follow-up needs staff"
};
const directBookingRequest = /\b(?:(?:can|could|may) (?:i|we) (?:(?:just|simply) )?(?:book|schedule|come in)|i(?:'d|’d| would) like to (?:book|schedule|come in)|please (?:book|schedule))\b/i;

function bookingReply(text, timeZone) {
  const [, clock, zone] = text.trim().match(statedClock) || [];
  return {
    requestedDay: text.trim().match(statedDay)?.[1] || "",
    requestedClock: !zone || timeZone === "Asia/Manila" ? clock || "" : ""
  };
}

function quotedPreference(value, message, previous, pattern) {
  const quote = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (quote.length > 64 || !pattern.test(quote)) return "";
  const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const present = new RegExp("(?<![\\p{L}\\p{N}:])" + escaped + "(?![\\p{L}\\p{N}:])", "iu");
  return present.test(message.replace(/\s+/g, " ")) || quote.toLowerCase() === previous?.toLowerCase() ? quote : "";
}

function calendarDay(quote, timeZone, received) {
  if (!quote || !timeZone) return quote;
  const phrase = quote.toLowerCase();
  const weekday = weekdays.findIndex(names => names.toLowerCase().split("|").includes(phrase.replace(/^this /, "")));
  const today = ["today", "karon", "ngayon"].includes(phrase);
  const tomorrow = ["tomorrow", "ugma", "bukas"].includes(phrase);
  if (weekday === -1 && !today && !tomorrow) return quote;

  let parts;
  try {
    parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(received);
  } catch {
    return quote;
  }
  const local = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const offset = tomorrow ? 1 : today ? 0 : (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + offset);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" }).format(date);
}

function bookingPreference(draft, text, previous, timeZone, received, collecting, shortReply) {
  const days = collecting ? [...text.matchAll(dayMention)] : [];
  const dateAlternatives = /\b(?:or|either|instead of|except|can['’]t|cannot|not)\b/i.test(text);
  const explicitBooking = directBookingRequest.test(text) || draft.intent === "booking" ||
    draft.handoffReason === "service_verification" || (draft.bookingIntent === true && !previous?.bookingActive);
  const uniqueDay = explicitBooking && days.length === 1 && !dateAlternatives ? days[0][1] : "";
  let requestedDay = shortReply.requestedDay || uniqueDay ||
    quotedPreference(draft.requestedDay, text, undefined, dayPreference);
  let dayAnchor = requestedDay ? received : previous?.dayAnchor ?? received;
  if (!requestedDay && (!explicitBooking || !days.length)) {
    requestedDay = quotedPreference(draft.requestedDay, "", previous?.requestedDay, dayPreference) ||
      (collecting ? previous?.requestedDay || "" : "");
  }

  let requestedClock = shortReply.requestedClock ||
    quotedPreference(draft.requestedClock, text, undefined, clockPreference);
  const changedDay = requestedDay && previous?.requestedDay &&
    requestedDay.toLowerCase() !== previous.requestedDay.toLowerCase();
  if (!requestedClock && !changedDay && !clockMention.test(text)) {
    requestedClock = quotedPreference(draft.requestedClock, "", previous?.requestedClock, clockPreference) ||
      (collecting ? previous?.requestedClock || "" : "");
  }
  const flexibility = quotedPreference(draft.flexibility, text, previous?.flexibility, flexiblePreference);
  // Recover a single complete preference the visitor typed if the model returned a malformed date.
  if (draft.intent === "booking" && (!requestedDay || !requestedClock)) {
    const matches = [...text.matchAll(completePreference)];
    if (matches.length === 1) {
      const [, dayQuote, clockQuote] = matches[0];
      if ((!requestedDay || requestedDay.toLowerCase() === dayQuote.toLowerCase()) &&
          (!requestedClock || requestedClock.toLowerCase() === clockQuote.toLowerCase())) {
        requestedDay = dayQuote;
        requestedClock = clockQuote;
        dayAnchor = received;
      }
    }
  }
  const dayLabel = calendarDay(requestedDay, timeZone, dayAnchor);
  const requestedTime = [dayLabel, requestedClock].filter(Boolean).join(" at ");
  return { requestedDay, requestedClock, flexibility, dayAnchor, dayLabel,
    requestedTime: flexibility && !(requestedDay && requestedClock)
      ? [requestedTime, flexibility].filter(Boolean).join(" · ") : requestedTime };
}

function dateAlreadyPassed({ dayLabel, requestedClock }, timeZone, received) {
  if (!timeZone || !/\b\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(dayLabel)) return false;
  const localToday = calendarDay("today", timeZone, received);
  const date = Date.parse(dayLabel + " UTC");
  const today = Date.parse(localToday + " UTC");
  if (date !== today) return date < today;

  const clock = requestedClock.toLowerCase().replace(/[.\s]/g, "");
  const [, hour, minute, meridiem] = clock.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)?$/) || [];
  const hourOfDay = clock === "noon" ? 12 : clock === "midnight" ? 0 :
    meridiem ? Number(hour) % 12 + (meridiem === "pm" ? 12 : 0) : Number(hour);
  const nowParts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(received);
  const local = Object.fromEntries(nowParts.map(({ type, value }) => [type, Number(value)]));
  return hourOfDay * 60 + Number(minute || 0) <= local.hour * 60 + local.minute;
}

function serviceLabel(value) {
  return value.toLowerCase().replace(/[-‑–]/g, "").replace(/\s+/g, " ").trim();
}

function mentionsService(text, service) {
  const name = serviceLabel(service).replace(/^dental /, "");
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?<![\\p{L}\\p{N}])" + escaped + "s?(?![\\p{L}\\p{N}])", "u").test(serviceLabel(text));
}

function parseClinicPages(raw, edenPageId) {
  if (!raw) return new Map();
  const config = JSON.parse(raw);
  if (!config || Array.isArray(config) || typeof config !== "object") throw Error("Invalid clinic Messenger configuration");
  return new Map(Object.entries(config).map(([pageId, page]) => {
    if (!pageNumber.test(pageId) || pageId === edenPageId || !page ||
        !isUuid(page.accountId) || !isUuid(page.locationId) ||
        typeof page.pageToken !== "string" || !page.pageToken.trim() ||
        typeof page.clinicName !== "string" || !page.clinicName.trim() || page.clinicName.length > 120 ||
        typeof page.facts !== "string" || !page.facts.trim() || page.facts.length > 6000) {
      throw Error("Invalid clinic Messenger Page configuration");
    }
    return [pageId, { ...page, pageToken: page.pageToken.trim() }];
  }));
}

function metaErrorHint(message) {
  if (typeof message !== "string") return "";
  const lower = message.toLowerCase();
  // Map Meta's error text to fixed labels so responses cannot leak into logs.
  if (lower.includes("invalid appsecret_proof")) return "app secret proof rejected";
  if (lower.includes("require an appsecret_proof")) return "app secret proof required";
  for (const permission of ["pages_manage_metadata", "pages_read_engagement", "pages_messaging", "pages_manage_engagement"]) {
    if (lower.includes(permission)) return `check ${permission} permission`;
  }
  if (lower.includes("unsupported get request")) return "unsupported Page read";
  return "";
}

function createClinicMessenger({ pages, appId, appSecret, ledger, recordOutcome, openaiKey, getStoredPageToken, commentPilot, readSetupTest,
  fetchImpl = fetch, now = Date.now, logger = console }) {
  const processors = new Map();
  const recentConversations = new Map();

  function rememberExchange(key, received, message, reply) {
    for (const [thread, exchanges] of recentConversations) {
      if (exchanges.at(-1).received <= received - day) recentConversations.delete(thread);
    }
    const exchanges = recentConversations.get(key) || [];
    recentConversations.delete(key);
    recentConversations.set(key, [...exchanges, { received, message: message.slice(0, 2000), reply }].slice(-recentExchangeLimit));
    if (recentConversations.size > recentConversationLimit) {
      recentConversations.delete(recentConversations.keys().next().value);
    }
  }

  async function graph(path, page, body) {
    if (!appSecret) throw Error("META_APP_SECRET is missing");
    const url = new URL("https://graph.facebook.com/v25.0/" + path);
    url.searchParams.set("appsecret_proof", createHmac("sha256", appSecret).update(page.pageToken).digest("hex"));
    const response = await fetchImpl(url.toString(), {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + page.pageToken, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(8000)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error) {
      const code = Number.isInteger(data?.error?.code) ? data.error.code : "unknown";
      const subcode = Number.isInteger(data?.error?.error_subcode) ? data.error.error_subcode : "none";
      const hint = metaErrorHint(data?.error?.message);
      throw Error(`Meta request failed: HTTP ${response.status}, code ${code}, subcode ${subcode}${hint ? `, ${hint}` : ""}`);
    }
    return data;
  }

  async function getPageToken(pageId, userToken) {
    const identity = await graph(pageId + "?fields=id,access_token", { pageToken: userToken });
    return String(identity.id) === pageId ? identity.access_token : null;
  }

  async function commentGraph(pageId, page, route, commentId, message) {
    const pageToken = await getStoredPageToken?.(pageId, route) || page.pageToken;
    if (!pageToken) throw Object.assign(new Error("The Facebook Page must be reconnected"), { status: 409 });
    const path = message ? `${commentId}/comments` : `${commentId}?fields=id,message,is_hidden`;
    return graph(path, { pageToken }, message ? { message } : undefined);
  }

  async function verifyPage(pageId, page, { subscribe = false } = {}) {
    if (!pageNumber.test(appId || "")) throw Error("META_APP_ID is missing");
    const identity = await graph("me?fields=id", page).catch(error => {
      throw Error("Page token identity check: " + error.message);
    });
    if (String(identity.id) !== pageId) return false;
    const readSubscription = async () => {
      const subscriptions = await graph(pageId + "/subscribed_apps", page).catch(error => {
        throw Error("Page webhook subscription check: " + error.message);
      });
      if (!Array.isArray(subscriptions.data)) throw Error("Unexpected Page webhook subscription result");
      return subscriptions.data.find(app => String(app.id) === appId)?.subscribed_fields || [];
    };
    const fields = await readSubscription();
    if (fields.includes("messages")) return true;
    if (!subscribe) return false;
    await graph(pageId + "/subscribed_apps", page, { subscribed_fields: [...fields, "messages"].join(",") });
    return (await readSubscription()).includes("messages");
  }

  function appointmentFollowup(draft, text, previous, submitted, timeZone, received) {
    const action = changeActions.has(draft.requestAction) ? draft.requestAction :
      draft.requestAction === "follow_up" ? "follow_up" : "";
    if (!action || (!submitted && action === "follow_up")) return null;
    const priorDetails = submitted?.details || {};
    const serviceBefore = priorDetails.service || "";
    const anchor = { targetCaseKey: submitted?.event_key, service: serviceBefore, requestedTime: "" };
    const acknowledge = (reply, details = anchor) => ({ ...details, intent: "handoff", requestAction: action, reply });

    if (action === "cancel") {
      return acknowledge("I’ve passed your cancellation request to the clinic team. They’ll follow up with you here.");
    }

    if (action === "follow_up") {
      return acknowledge("I’ve passed your follow-up to the clinic team. They’ll get back to you here.");
    }

    if (action === "change_service") {
      const service = typeof draft.service === "string" ? draft.service.trim().slice(0, 100) : "";
      if (service && serviceLabel(service) === serviceLabel(serviceBefore)) {
        return { intent: "answer", reply: "The request already lists " + serviceBefore.toLowerCase() + "." };
      }
      if (!service || !mentionsService(text, service)) {
        return { ...anchor, intent: "answer", pendingAction: action, reply: "What service would you like instead?" };
      }
      return acknowledge("I’ve shared your updated service request with the clinic team. They’ll confirm what they can arrange.",
        { ...anchor, service, requestedTime: priorDetails.requestedTime || "" });
    }

    const pending = previous?.pendingAction === action && previous.targetCaseKey === submitted?.event_key;
    const originalDay = typeof priorDetails.requestedTime === "string" && priorDetails.requestedTime.includes(" at ")
      ? priorDetails.requestedTime.split(" at ", 1)[0] : "";
    const appointmentAt = Date.parse(submitted?.staffAction?.appointment_at);
    const confirmedDay = Number.isFinite(appointmentAt) && timeZone ? calendarDay("today", timeZone, appointmentAt) : "";
    const verifiedDay = confirmedDay || (dayPreference.test(originalDay) ? originalDay : "");
    const preference = bookingPreference(draft, text, {
      requestedDay: pending ? previous.requestedDay : verifiedDay,
      requestedClock: pending ? previous.requestedClock : "",
      dayAnchor: pending ? previous.dayAnchor : received
    }, timeZone, received, true, bookingReply(text, timeZone));
    const passed = preference.requestedDay && preference.requestedClock && dateAlreadyPassed(preference, timeZone, received);
    if (!preference.requestedDay || /^next /i.test(preference.requestedDay) || !preference.requestedClock || passed) {
      return { ...anchor, ...preference, intent: "answer", pendingAction: action,
        ...(passed ? { requestedDay: "", requestedClock: "" } : {}),
        reply: passed ? "That time has already passed. What other day and time would work?" :
          !preference.requestedDay || /^next /i.test(preference.requestedDay)
            ? "What date would you like instead?" : "What time would work on that day?" };
    }
    if (preference.requestedTime === priorDetails.requestedTime) {
      return { intent: "answer", reply: "The clinic team already has that requested time." };
    }
    return acknowledge("I’ve passed the request for " + preference.requestedTime +
      " to the clinic team. They’ll confirm the change here.", { ...anchor, ...preference });
  }

  async function draftReply(page, previous, history, text, facts, timeZone, received, submitted) {
    if (!openaiKey) return fallback;
    try {
      const result = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + openaiKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          model: "gpt-4o-mini", store: false, response_format: { type: "json_object" },
          max_tokens: 500,
          messages: [
            { role: "system", content: `You are the AI receptionist for ${page.clinicName}. Use only the approved facts below. Never diagnose, prescribe, promise a slot, or say an appointment is confirmed. For urgent concerns direct the visitor to local emergency services and hand off. Hand off clinical questions, explicit requests for a person, and changes to existing appointments. A visitor saying they are nervous is a cue for reassurance. Do not gather or repeat medical history.
${conversationalStyle}

Return JSON with intent (answer, booking, or handoff), reply, handoffReason (clinical, staff_requested, existing_appointment, service_verification, or other), bookingIntent (true when the visitor has asked to make a new booking and is still giving details), service, serviceSelected, serviceNeedsCheck, requestedDay, requestedClock, flexibility, and replyLanguage (en, tl, or ceb). Use answer while clarifying or answering questions. Use booking when the visitor clearly wants a request submitted and has provided the service and a specific day/date and exact clock time, or explicitly authorizes a flexible request. If their preferred time has already passed, ask for a new preference. Do not treat an availability question as consent by itself. The clinic team confirms the appointment.
Service is the service the visitor actually wants. Keep priorService until they clearly request or choose another specific service in their own words. Set serviceSelected to true only if they name and choose that service in this message. A time, a generic yes, or a question about an alternative does not choose a different service. When a service is absent from approved facts, set serviceNeedsCheck to true, say you can check with the team, and keep the original service. Don't assume the clinic doesn't offer it. If they want to come in, use answer while collecting their preferred day and exact time. Service verification alone must keep the conversation open while appointment details are missing. For “Could I come in for a cleaning Thursday afternoon?” when cleaning is unlisted, a good reply is “We can take it at your pace. I can ask the team about a cleaning. What time Thursday afternoon works for you?” Carry Thursday forward after they give the clock time. Once the request is complete, use booking so the server can route it for staff verification. Reserve handoffReason service_verification for an appointment request about an unlisted service. Use the other handoff reasons for clinical questions, requests for a person, or other issues. Offer alternatives only when asked and keep any alternative out of the service field until they choose it.
For requestedDay and requestedClock, quote the visitor's words as separate fields, for example "Thursday, November 19" and "3:15 PM". Read the recent exchanges and priorPreference together. Carry forward the known details if they still apply. The latest correction wins. If they supply a time after you asked for one, keep their earlier day. Never ask for a day or time they already gave. Quote day and time only, excluding names and other private details. Keep the year exactly as supplied. Leave AM or PM out until the visitor supplies it. Use flexibility only for a short direct quote like "I'm flexible" or "any time works", never for a partial preference or a tentative reply. If the date, time zone or time is ambiguous or the visitor named a different time zone, ask what clinic-local date and time they prefer. Treat "next Thursday" and similar phrases as ambiguous until the visitor specifies the calendar date. Return empty strings for unknown or withdrawn details. The message arrived at ${new Date(received).toISOString()}. The clinic time zone is ${timeZone || "unspecified"}.
After a request has been sent, keep answering the visitor’s practical follow-up questions using approved facts, even while staff reviews the request. Answer the question directly. Skip another invitation to book when it is the same visit. Acknowledgements and repeats of an already submitted preference should get a brief acknowledgement without sending again. The visitor can ask for changes or a cancellation while staff reviews. Use requestAction (change_time, change_service, cancel, follow_up, new_booking or empty). Use change_time for a clearly requested new date or time for the referenced request, change_service for a requested replacement service, and cancel for an explicit request to cancel the referenced appointment or request. An informational question about changes, availability, or cancellation policy is an answer with no action. Use follow_up only when a staff reply is needed and the question cannot be answered from approved facts. Use new_booking only when the visitor explicitly asks for another appointment; if the target of a change is unclear, ask which appointment they mean. If the visitor is answering a question asked for pendingAction, repeat that action and give the newly supplied detail. The server records staff requests. Never say a change or cancellation has already taken effect. For example, after a cleaning request, “Where are you?” gets the approved address. “Can we move it to 5 PM?” requests change_time. “What’s your cancellation policy?” is a question. “Please cancel that appointment” requests cancel.
Approved clinic facts:
${facts ? JSON.stringify(facts) : page.facts}` },
            ...(history.length ? history.flatMap(({ message, reply }) => [
              { role: "user", content: message }, { role: "assistant", content: reply }
            ]) : previous ? [{ role: "assistant", content: previous.reply }] : []),
            { role: "user", content: JSON.stringify({
              priorService: previous?.service || "",
              priorBookingIntent: previous?.bookingActive === true,
              pendingAction: previous?.pendingAction || "",
              submittedRequest: submitted ? {
                service: submitted.details.service || "",
                requestedTime: submitted.details.requestedTime || "",
                previousRequestType: submitted.kind,
                staffAction: submitted.staffAction?.recorded_action || submitted.staffAction?.action || ""
              } : null,
              priorServiceNeedsCheck: previous?.serviceNeedsCheck === true,
              priorPreference: {
                requestedDay: previous?.requestedDay || "",
                requestedClock: previous?.requestedClock || "",
                flexibility: previous?.flexibility || ""
              },
              message: text.slice(0, 2000)
            }) }
          ]
        })
      });
      if (!result.ok) return fallback;
      const data = await result.json();
      const draft = JSON.parse(data.choices?.[0]?.message?.content || "");
      const proposedService = typeof draft.service === "string" ? draft.service.trim().slice(0, 100) : "";
      const priorService = previous?.service || "";
      const differentService = priorService && proposedService && serviceLabel(priorService) !== serviceLabel(proposedService);
      const serviceChanged = differentService && draft.serviceSelected === true && mentionsService(text, proposedService);
      const service = priorService && !serviceChanged ? priorService : proposedService;
      const serviceNeedsCheck = Boolean(service && (draft.serviceNeedsCheck === true ||
        (!serviceChanged && previous?.serviceNeedsCheck === true) ||
        (typeof facts?.services === "string" && facts.services.trim() && !mentionsService(facts.services, service))));
      if (!["answer", "booking", "handoff"].includes(draft.intent) ||
          typeof draft.reply !== "string" || !draft.reply.trim()) return fallback;
      const availableRequest = submitted && (submitted.kind === "booking.requested" || submitted.details.requestedTime);
      const previousFollowup = previous?.lastFollowup;
      const statedPreference = bookingReply(text, timeZone);
      const completingTimeChange = previous?.pendingAction === "change_time" && draft.intent === "answer" &&
        (statedPreference.requestedDay || statedPreference.requestedClock);
      const requestAction = draft.requestAction || (completingTimeChange ? "change_time" : "");
      if (requestAction === "cancel" && previousFollowup?.action === "cancel") {
        return { intent: "answer", lastFollowup: previousFollowup,
          reply: "The clinic team already has your cancellation request and will follow up here." };
      }

      const related = appointmentFollowup({ ...draft, requestAction }, text, previous, availableRequest ? submitted :
        requestAction === "follow_up" ? submitted : null, timeZone, received);
      if (related) return related;
      const staffAction = submitted?.staffAction?.recorded_action || submitted?.staffAction?.action;
      const priorRequestResolved = ["handled", "cancelled"].includes(staffAction);
      const separateBooking = requestAction === confirmedNewRequest || secondBooking.test(text) ||
        (priorRequestResolved && directBookingRequest.test(text)) ||
        (previous?.newBooking === true && previous?.bookingActive === true);
      if (availableRequest && !separateBooking) {
        if (draft.intent === "booking" || statedPreference.requestedDay || statedPreference.requestedClock) {
          return { intent: "answer", reply: "The clinic team has your request and will follow up here.",
            ...(previousFollowup ? { lastFollowup: previousFollowup } : {}) };
        }
      }
      const serviceVerification = draft.intent === "handoff" &&
        draft.handoffReason === "service_verification" && serviceNeedsCheck;
      const continuing = previous?.bookingActive === true;
      const bookingActive = draft.intent === "booking" || serviceVerification ||
        (draft.intent === "answer" && (!availableRequest || separateBooking) &&
          (continuing || draft.bookingIntent === true || directBookingRequest.test(text)));
      const shortReply = continuing && draft.intent !== "handoff" ? bookingReply(text, timeZone) : {};
      const request = { service, serviceNeedsCheck, bookingActive, ...(separateBooking ? { newBooking: true } : {}),
        ...bookingPreference(draft, text, previous, timeZone, received, bookingActive, shortReply) };
      const suppliedMissingDetail = (shortReply.requestedClock && !previous?.requestedClock) ||
        (shortReply.requestedDay && (!previous?.requestedDay || /^next /i.test(previous.requestedDay)));
      const continuation = suppliedMissingDetail && request.requestedDay && request.requestedClock;
      const intake = draft.intent === "booking" || serviceVerification || continuation;
      if (intake && facts?.bookingMode === "information") {
        return { intent: "answer", reply: "I can help with clinic questions. Please contact the clinic team to request an appointment.",
          service, requestedTime: "" };
      }
      if (bookingActive && deferring.test(text.trim())) {
        return { intent: "answer", reply: "Of course. Take your time.", service, serviceNeedsCheck, requestedTime: "" };
      }
      if (intake) {
        const { requestedDay, requestedClock, flexibility, requestedTime } = request;
        const ambiguousDate = /^next /i.test(requestedDay);
        const needsDate = !requestedDay || ambiguousDate;
        if (!service || ambiguousDate || (!flexibility && (needsDate || !requestedClock))) {
          const question = !service ? "What would you like to come in for?" :
            needsDate ? "What date works for you?" : "What time works best that day?";
          const checking = serviceNeedsCheck && !previous?.serviceNeedsCheck;
          const reply = checking ? "I can ask the team about " + service.toLowerCase() + ". " + question : question;
          return { intent: "answer", reply, ...request };
        }
        if (requestedDay && requestedClock && dateAlreadyPassed(request, timeZone, received)) {
          return { intent: "answer", reply: "That time has already passed. What other day and time would work for you?",
            service, serviceNeedsCheck, bookingActive, requestedTime: "" };
        }
        if (serviceNeedsCheck) {
          const reply = requestedDay && requestedClock
            ? "I’ve asked our team to check on " + service.toLowerCase() + " for " + requestedTime + ". They’ll let you know here what’s possible."
            : "I’ve asked our team to check on " + service.toLowerCase() + ". They’ll follow up here about your request.";
          return { intent: "handoff", reply, ...request };
        }
        const reply = requestedDay && requestedClock
          ? "I’ve passed along your request for " + requestedTime + ". The clinic team will confirm the appointment here."
          : "Thanks, I’ve shared your preferences with the clinic team. They’ll message you here to confirm a time.";
        const localized = ["tl", "ceb"].includes(draft.replyLanguage)
          ? "Sige. " + reply.replace(/^Thanks, I’ve/, "I’ve") : reply;
        return { intent: "booking", reply: localized, ...request };
      }
      return { intent: draft.intent, reply: draft.reply.trim().slice(0, 900), ...request,
        ...(submitted && draft.intent === "handoff" ? { targetCaseKey: submitted.event_key, requestAction: "follow_up" } : {}),
        ...(previousFollowup && draft.intent === "answer" ? { lastFollowup: previousFollowup } : {}) };

    } catch {
      return fallback;
    }
  }

  async function handleText(page, { pageId, senderId, messageId, text, timestamp, hasAttachment }) {
    const received = Number(timestamp);
    if (typeof senderId !== "string" || !pageNumber.test(senderId) ||
        typeof messageId !== "string" || messageId.length > 300 || !Number.isFinite(received) ||
        received <= now() - day || received > now() + 60000) return;
    const route = await ledger.messengerLocation(pageId, page);
    if (!route) return;
    const pageToken = (await getStoredPageToken?.(pageId, route)) || page.pageToken;
    if (!pageToken) return;

    const isSetupMessage = route.location.messenger_facts && text.trim().startsWith("EDEN SETUP TEST ");
    const testId = isSetupMessage && !hasAttachment && readSetupTest?.(text.trim(), pageId, page, received);
    if (isSetupMessage && !testId) return;
    const conversationKey = testId
      ? outcomeKey("clinic_messenger_setup_test", route.account_id, route.location_id, pageId, testId)
      : outcomeKey("clinic_messenger_thread", route.account_id, route.location_id, pageId, senderId);
    const eventKey = outcomeKey("clinic_messenger_turn", conversationKey, testId || messageId);
    let turn = await ledger.messengerTurn(eventKey);
    let customerMessage = "";
    if (!turn && testId) {
      const setupUrl = new URL("https://clinicnet.live/clinic/");
      setupUrl.search = new URLSearchParams({ messengerTest: testId, account: route.account_id, location: route.location_id });
      turn = await ledger.prepareMessengerTurn({
        event_key: eventKey, conversation_key: conversationKey, received_at: new Date(received).toISOString(),
        draft: { intent: "booking", service: "Sample consultation", requestedTime: "Example weekday afternoon",
          reply: "Eden received your test message and replied successfully. Open your setup page below to see the result.\n\n" + setupUrl.href },
        case_key: outcomeKey("clinic_messenger_case", eventKey)
      });
    }
    if (!turn) {
      const previous = await ledger.recentMessengerTurn(conversationKey);
      if (previous && Date.parse(previous.received_at) > received) return;
      const priorCase = previous?.case_key && Date.parse(previous.received_at) > received - referenceWindow
        ? previous : previous && await ledger.recentMessengerTurn(conversationKey, {
          caseSince: new Date(received - referenceWindow).toISOString()
        });
      const caseKey = priorCase?.draft?.targetCaseKey || priorCase?.case_key;
      const submitted = caseKey && await ledger.messengerCase(route, caseKey, pageId, senderId);
      const context = previous && Date.parse(previous.received_at) > received - day
        ? { ...previous.draft, ...(previous.case_key ? { bookingActive: false } : {}) } : null;
      const history = (recentConversations.get(conversationKey) || [])
        .filter(exchange => exchange.received > received - day);
      const message = await commentPilot?.messageContext({ pageId, route, text, received,
        previousSource: previous?.draft?.commentSource }) || { text };
      let draft = fallback;
      if (!hasAttachment && message.text) {
        customerMessage = message.text;
        draft = await draftReply(page, context, history, message.text, route.location.messenger_facts,
          route.location.timezone, received, submitted);
      }
      if (!hasAttachment && !message.text && message.source) {
        draft = { intent: "answer", service: "", requestedTime: "",
          reply: "Thanks for messaging us about our Facebook post. How can we help?" };
      }
      if (draft.requestAction && draft.intent === "handoff") {
        draft = { ...draft, lastFollowup: { action: draft.requestAction } };
      }
      if (message.source) draft = { ...draft, commentSource: message.source };
      turn = await ledger.prepareMessengerTurn({
        event_key: eventKey, conversation_key: conversationKey, received_at: new Date(received).toISOString(),
        draft, case_key: draft.intent === "answer" ? null : outcomeKey("clinic_messenger_case", eventKey)
      });
    }
    const commentSource = turn.draft.commentSource;
    if (commentSource?.received === received) await commentPilot?.recordStarted(route, conversationKey, commentSource);
    const canActivate = route.status === "verifying" && Boolean(turn.case_key);
    const saveCase = async (key, intent) => {
      const { requestAction, targetCaseKey } = turn.draft;
      const related = requestAction && targetCaseKey;
      if (related && ["change_time", "change_service"].includes(requestAction) &&
          await ledger.amendMessengerRequest(route, pageId, senderId, targetCaseKey, key, turn.draft)) return;
      return recordOutcome({
        event_key: key, clinic_id: route.location_id, account_id: route.account_id, location_id: route.location_id,
        channel: "facebook_messenger", kind: intent === "booking" ? "booking.requested" : "inquiry.followup_needed",
        status: intent === "booking" ? "AWAITING_CLINIC" : "NEEDS_STAFF",
        summary: testId ? "Messenger setup test" : requestAction ? followupTitles[requestAction] :
          intent === "booking" ? "Messenger booking request" : "Messenger conversation needs staff",
        details: {
          pageId, ...(testId ? { demo: true, messengerSetupTestId: testId } : { senderId }),
          service: turn.draft.service, requestedTime: turn.draft.requestedTime,
          ...(requestAction ? { messengerRequestAction: requestAction } : {}),
          ...(related ? { relatedRequestKey: targetCaseKey } : {}),
          ...(commentSource ? { commentPilotPostId: commentSource.postId, commentPilotCode: commentSource.code } : {}),
          ...(intent === "booking" ? { bookingId: key } : {})
        },
        notify_to: testId ? null : route.location.alert_email
      });
    };
    const finishSent = async () => {
      if (testId) await saveCase(turn.case_key, "booking");
      if (canActivate) await ledger.activateMessengerConnection(route);
    };
    if (turn.state === "sent") return finishSent();

    if (turn.state === "sending" || turn.state === "needs_review") {
      if (turn.state === "sending" && now() - Date.parse(turn.updated_at) < 20000) {
        throw Error("Messenger reply is still in flight");
      }
      const key = turn.case_key || outcomeKey("clinic_messenger_case", eventKey);
      if (!testId) await saveCase(key, turn.draft.intent === "booking" ? "booking" : "handoff");
      await ledger.updateMessengerTurn(eventKey, turn.state, "needs_review", key);
      return;
    }
    if (turn.case_key && !testId) await saveCase(turn.case_key, turn.draft.intent);
    if (received <= now() - day) return;
    if (!await ledger.updateMessengerTurn(eventKey, "prepared", "sending")) {
      throw Error("Messenger reply already claimed");
    }

    try {
      const send = await graph(pageId + "/messages", { pageToken }, {
        recipient: { id: senderId }, messaging_type: "RESPONSE",
        message: { text: turn.draft.reply }
      });
      if (!send.message_id) throw Error("Meta did not confirm the reply");
    } catch {
      const key = turn.case_key || outcomeKey("clinic_messenger_case", eventKey);
      if (!testId) await saveCase(key, turn.draft.intent === "booking" ? "booking" : "handoff");
      await ledger.updateMessengerTurn(eventKey, "sending", "needs_review", key);
      logger.warn("Clinic Messenger reply needs staff review");
      return;
    }

    const markedSent = await ledger.updateMessengerTurn(eventKey, "sending", "sent");
    if (testId && !markedSent) throw Error("Messenger setup reply could not be recorded");
    if (markedSent && customerMessage) {
      rememberExchange(conversationKey, received, customerMessage, turn.draft.reply);
    }
    await finishSent();
  }

  function registerPage(pageId, page) {
    processors.set(pageId, createMessengerProcessor({
      pageId, now, logger, includeAttachments: true, handleText: event => handleText(page, event)
    }));
  }
  for (const [pageId, page] of pages) registerPage(pageId, page);

  async function processPayload(payload) {
    if (payload?.object !== "page" || !Array.isArray(payload.entry)) return;
    const entries = new Map();
    for (const entry of payload.entry) {
      const pageId = String(entry?.id);
      if (!processors.has(pageId)) continue;
      if (!entries.has(pageId)) entries.set(pageId, []);
      entries.get(pageId).push(entry);
    }
    const results = await Promise.allSettled([...entries].map(([id, entry]) =>
      processors.get(id).processPayload({ object: "page", entry })));
    if (results.some(result => result.status === "rejected")) throw Error("Clinic Messenger processing failed");
  }

  return { processPayload, verifyPage, getPageToken, registerPage, commentGraph };
}

module.exports = { createClinicMessenger, parseClinicPages, pageNumber };
