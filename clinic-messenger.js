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

function metaErrorHint(message) {
  if (typeof message !== "string") return "";
  const lower = message.toLowerCase();
  // Map Meta's error text to fixed labels so responses cannot leak into logs.
  if (lower.includes("invalid appsecret_proof")) return "app secret proof rejected";
  if (lower.includes("require an appsecret_proof")) return "app secret proof required";
  for (const permission of ["pages_manage_metadata", "pages_read_engagement", "pages_messaging"]) {
    if (lower.includes(permission)) return `check ${permission} permission`;
  }
  if (lower.includes("unsupported get request")) return "unsupported Page read";
  return "";
}

function createClinicMessenger({ pages, appId, appSecret, ledger, recordOutcome, openaiKey, getStoredPageToken, commentPilot,
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
    const pageToken = (await getStoredPageToken?.(pageId, route)) || page.pageToken;
    if (!pageToken) return;

    const conversationKey = outcomeKey("clinic_messenger_thread", route.account_id, route.location_id, pageId, senderId);
    const eventKey = outcomeKey("clinic_messenger_turn", conversationKey, messageId);
    let turn = await ledger.messengerTurn(eventKey);
    if (!turn) {
      const previous = await ledger.recentMessengerTurn(conversationKey);
      if (previous && Date.parse(previous.received_at) > received) return;
      if (previous?.case_key && await ledger.messengerCaseOpen(route, previous.case_key)) return;
      const context = previous && !previous.case_key && Date.parse(previous.received_at) > now() - day
        ? previous.draft : null;
      const message = await commentPilot?.messageContext({ pageId, route, text, received,
        previousSource: previous?.draft?.commentSource }) || { text };
      let draft = fallback;
      if (!hasAttachment && message.text) draft = await draftReply(page, context, message.text);
      if (!hasAttachment && !message.text && message.source) {
        draft = { intent: "answer", service: "", requestedTime: "",
          reply: "Thanks for messaging us about our Facebook post. How can we help?" };
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
    if (turn.state === "sent") {
      if (canActivate) await ledger.activateMessengerConnection(route);
      return;
    }

    const saveCase = (key, intent) => recordOutcome({
      event_key: key, clinic_id: route.location_id, account_id: route.account_id, location_id: route.location_id,
      channel: "facebook_messenger", kind: intent === "booking" ? "booking.requested" : "inquiry.followup_needed",
      status: intent === "booking" ? "AWAITING_CLINIC" : "NEEDS_STAFF",
      summary: intent === "booking" ? "Messenger booking request" : "Messenger conversation needs staff",
      details: {
        pageId, senderId, service: turn.draft.service, requestedTime: turn.draft.requestedTime,
        ...(commentSource ? { commentPilotPostId: commentSource.postId, commentPilotCode: commentSource.code } : {}),
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
      const send = await graph(pageId + "/messages", { pageToken }, {
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
    if (canActivate) await ledger.activateMessengerConnection(route);
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

  return { processPayload, verifyPage, getPageToken, registerPage };
}

module.exports = { createClinicMessenger, parseClinicPages, pageNumber };
