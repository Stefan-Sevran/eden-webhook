const { createHmac } = require("node:crypto");
const { createMessengerProcessor } = require("./messenger-events");
const { outcomeKey } = require("./outcome-ledger");
const { isUuid } = require("./clinic-tenant");

const day = 24 * 60 * 60 * 1000;
const pageNumber = /^\d{5,30}$/;
const fallback = {
  intent: "handoff", service: "", requestedTime: "",
  reply: "I’ll ask the clinic team to help here. They’ll follow up as soon as they can."
};

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

function createClinicMessenger({ pages, appId, appSecret, ledger, recordOutcome, openaiKey,
  fetchImpl = fetch, now = Date.now, logger = console }) {
  const processors = new Map();

  async function graph(path, page, body) {
    if (!appSecret) throw Error("META_APP_SECRET is missing");
    const url = new URL("https://graph.facebook.com/v25.0/" + path);
    url.searchParams.set("appsecret_proof", createHmac("sha256", appSecret).update(page.pageToken).digest("hex"));
    const response = await fetchImpl(url.toString(), {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + page.pageToken, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error) {
      const code = Number.isInteger(data?.error?.code) ? data.error.code : "unknown";
      const subcode = Number.isInteger(data?.error?.error_subcode) ? data.error.error_subcode : "none";
      throw Error(`Meta request failed: HTTP ${response.status}, code ${code}, subcode ${subcode}`);
    }
    return data;
  }

  async function verifyPage(pageId, page) {
    if (!pageNumber.test(appId || "")) throw Error("META_APP_ID is missing");
    const identity = await graph("me?fields=id", page).catch(error => {
      throw Error("Page token identity check: " + error.message);
    });
    if (String(identity.id) !== pageId) return false;
    const subscriptions = await graph(pageId + "/subscribed_apps", page).catch(error => {
      throw Error("Page webhook subscription check: " + error.message);
    });
    return subscriptions.data?.some(app =>
      String(app.id) === appId && app.subscribed_fields?.includes("messages")) === true;
  }

  async function draftReply(page, previous, text) {
    if (!openaiKey) return fallback;
    try {
      const result = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + openaiKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          model: "gpt-4o-mini", store: false, response_format: { type: "json_object" },
          max_tokens: 320,
          messages: [
            { role: "system", content: `You are the AI receptionist for ${page.clinicName}. Answer using the approved facts only. Do not give medical advice, promise availability, confirm appointments, ask for medical details, or repeat sensitive patient details. Offer one helpful next step in the visitor's language.
Return JSON with intent (answer, booking, or handoff), reply, service, and requestedTime. For questions or tentative interest, answer first and ask one brief question. Use booking only when the person asks to book and has provided a service and preferred time or day, including when they say they are flexible. A booking is a request for staff confirmation. Use handoff for a human request, clinical/urgent issues, changes to existing bookings, or issues you cannot resolve. Keep service and requestedTime brief and exclude names and health history. If urgent, direct them to local emergency services.
Approved clinic facts:
${page.facts}` },
            ...(previous ? [{ role: "assistant", content: previous.reply }] : []),
            { role: "user", content: JSON.stringify({
              priorService: previous?.service || "", priorRequestedTime: previous?.requestedTime || "",
              message: text.slice(0, 2000)
            }) }
          ]
        })
      });
      if (!result.ok) return fallback;
      const data = await result.json();
      const draft = JSON.parse(data.choices?.[0]?.message?.content || "");
      const service = typeof draft.service === "string" ? draft.service.trim().slice(0, 100) : "";
      const requestedTime = typeof draft.requestedTime === "string" ? draft.requestedTime.trim().slice(0, 100) : "";
      if (!["answer", "booking", "handoff"].includes(draft.intent) ||
          typeof draft.reply !== "string" || !draft.reply.trim() ||
          (draft.intent === "booking" && (!service || !requestedTime))) return fallback;
      const reply = draft.intent === "booking"
        ? "I’ve passed your booking request to the clinic team. They’ll confirm the appointment with you here."
        : draft.reply.trim().slice(0, 900);
      return { intent: draft.intent, reply, service, requestedTime };
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

    const conversationKey = outcomeKey("clinic_messenger_thread", route.account_id, route.location_id, pageId, senderId);
    const eventKey = outcomeKey("clinic_messenger_turn", conversationKey, messageId);
    let turn = await ledger.messengerTurn(eventKey);
    if (!turn) {
      const previous = await ledger.recentMessengerTurn(conversationKey);
      if (previous && Date.parse(previous.received_at) > received) return;
      if (previous?.case_key && await ledger.messengerCaseOpen(route, previous.case_key)) return;
      const context = previous && !previous.case_key && Date.parse(previous.received_at) > now() - day
        ? previous.draft : null;
      const draft = text && !hasAttachment ? await draftReply(page, context, text) : fallback;
      turn = await ledger.prepareMessengerTurn({
        event_key: eventKey, conversation_key: conversationKey, received_at: new Date(received).toISOString(),
        draft, case_key: draft.intent === "answer" ? null : outcomeKey("clinic_messenger_case", eventKey)
      });
    }
    if (turn.state === "sent") {
      if (route.status === "verifying") await ledger.activateMessengerConnection(route);
      return;
    }

    const saveCase = (key, intent) => recordOutcome({
      event_key: key, clinic_id: route.location_id, account_id: route.account_id, location_id: route.location_id,
      channel: "facebook_messenger", kind: intent === "booking" ? "booking.requested" : "inquiry.followup_needed",
      status: intent === "booking" ? "AWAITING_CLINIC" : "NEEDS_STAFF",
      summary: intent === "booking" ? "Messenger booking request" : "Messenger conversation needs staff",
      details: {
        pageId, senderId, service: turn.draft.service, requestedTime: turn.draft.requestedTime,
        ...(intent === "booking" ? { bookingId: key } : {})
      },
      notify_to: route.location.alert_email
    });

    if (turn.state === "sending" || turn.state === "needs_review") {
      if (turn.state === "sending" && now() - Date.parse(turn.updated_at) < 20000) {
        throw Error("Messenger reply is still in flight");
      }
      const key = turn.case_key || outcomeKey("clinic_messenger_case", eventKey);
      await saveCase(key, turn.draft.intent === "booking" ? "booking" : "handoff");
      await ledger.updateMessengerTurn(eventKey, turn.state, "needs_review", key);
      return;
    }
    if (turn.case_key) await saveCase(turn.case_key, turn.draft.intent);
    if (received <= now() - day) return;
    if (!await ledger.updateMessengerTurn(eventKey, "prepared", "sending")) {
      throw Error("Messenger reply already claimed");
    }

    try {
      const send = await graph(pageId + "/messages", page, {
        recipient: { id: senderId }, messaging_type: "RESPONSE",
        message: { text: turn.draft.reply }
      });
      if (!send.message_id) throw Error("Meta did not confirm the reply");
    } catch {
      const key = turn.case_key || outcomeKey("clinic_messenger_case", eventKey);
      await saveCase(key, turn.draft.intent === "booking" ? "booking" : "handoff");
      await ledger.updateMessengerTurn(eventKey, "sending", "needs_review", key);
      logger.warn("Clinic Messenger reply needs staff review");
      return;
    }

    await ledger.updateMessengerTurn(eventKey, "sending", "sent");
    if (route.status === "verifying") await ledger.activateMessengerConnection(route);
  }

  for (const [pageId, page] of pages) {
    processors.set(pageId, createMessengerProcessor({
      pageId, now, logger, includeAttachments: true, handleText: event => handleText(page, event)
    }));
  }

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

  return { processPayload, verifyPage };
}

module.exports = { createClinicMessenger, parseClinicPages, pageNumber };
