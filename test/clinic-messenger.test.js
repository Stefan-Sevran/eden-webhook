const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createClinicMessenger, parseClinicPages } = require("../clinic-messenger");
const { createCommentPilot, parseCommentPilot } = require("../clinic-comment-pilot");

const pageId = "1234567890", appId = "9876543210", sender = "5555512345";
const accountId = "9e939ec0-b740-448e-8a92-886548e922e2";
const locationId = "e2395766-3859-4c89-b452-6f3a7a9f9422";
const page = { accountId, locationId, pageToken: "page-key", clinicName: "Pearl Dental", facts: "Open 9–5." };
const timestamp = Date.parse("2026-11-06T10:00:00Z");
const clock = { now: timestamp + 1000 };

function payload(mid, text, at = timestamp, page = pageId) {
  return { object: "page", entry: [{ id: page, messaging: [{
    timestamp: at, sender: { id: sender }, message: { mid, ...(text ? { text } : { attachments: [{ type: "image" }] }) }
  }] }] };
}

function fixture(commentConfig, readSetupTest, modelDraft) {
  const turns = new Map(), cases = new Map(), sends = [], modelInputs = [];
  const route = { account_id: accountId, location_id: locationId, status: "verifying", location: { alert_email: "clinic@example.test" } };
  let connected = true, staffAction, sendFails = false;
  const ledger = {
    async messengerLocation(id, config) {
      assert.equal(id, pageId); assert.equal(config.locationId, locationId);
      return connected ? route : null;
    },
    async activateMessengerConnection() { route.status = "connected"; },
    async messengerTurn(key) { return turns.get(key); },
    async recentMessengerTurn(key, { caseSince, withPreference } = {}) {
      return [...turns.values()].reverse().find(turn => turn.conversation_key === key &&
        (!caseSince || (turn.case_key && turn.received_at >= caseSince)) &&
        (!withPreference || turn.draft.requestedTime));
    },
    async messengerCase(route, key, candidatePage, candidateSender) {
      const event = cases.get(key);
      return event?.account_id === route.account_id && event.location_id === route.location_id &&
        event.details.pageId === candidatePage && event.details.senderId === candidateSender ? { ...event, staffAction } : null;
    },
    async amendMessengerRequest(route, candidatePage, candidateSender, key, changeKey, draft) {
      const event = await this.messengerCase(route, key, candidatePage, candidateSender);
      if (!event || staffAction) return false;
      const changes = event.details.messengerAmendments ||= [];
      if (!changes.includes(changeKey)) {
        changes.push(changeKey);
        if (draft.requestAction === "change_time") event.details.requestedTime = draft.requestedTime;
        if (draft.requestAction === "change_service") event.details.service = draft.service;
      }
      return true;
    },
    async commentDraft(candidate, postId, code) {
      return [...cases.values()].some(event => event.kind === "comment.draft" &&
        event.account_id === candidate.account_id && event.location_id === candidate.location_id &&
        event.details.commentPilotPostId === postId && event.details.commentPilotCode === code);
    },
    async prepareMessengerTurn(turn) {
      const row = { ...turn, state: "prepared" };
      if (!turns.has(turn.event_key)) turns.set(turn.event_key, row);
      return turns.get(turn.event_key);
    },
    async updateMessengerTurn(key, expected, state, caseKey) {
      const row = turns.get(key);
      if (row.state !== expected) return false;
      turns.set(key, { ...row, state, case_key: caseKey || row.case_key,
        updated_at: new Date(clock.now).toISOString() });
      return true;
    }
  };
  async function recordOutcome(event) { if (!cases.has(event.event_key)) cases.set(event.event_key, event); }
  const commentPilot = commentConfig && createCommentPilot({ config: commentConfig, ledger, recordOutcome,
    getPage: id => id === pageId ? page : null, now: () => clock.now });
  const make = () => createClinicMessenger({
    pages: new Map([[pageId, page]]), appId, appSecret: "app-secret", ledger, openaiKey: "ai-key", now: () => clock.now,
    logger: { warn() {} }, recordOutcome, commentPilot, readSetupTest,
    async fetchImpl(url, options) {
      if (url.includes("api.openai.com")) {
        const body = JSON.parse(options.body);
        modelInputs.push(body);
        assert.ok(body.messages[0].content.includes(route.location.messenger_facts ?
          JSON.stringify(route.location.messenger_facts) : "Open 9–5"));
        const input = JSON.parse(body.messages.at(-1).content);
        const draft = modelDraft ? modelDraft(input) : input.message === "Please book Saturday at 2 PM" ?
          { intent: "booking", reply: "Untrusted wording", service: input.priorService, requestedDay: "Saturday", requestedClock: "2 PM" } :
          { intent: "answer", reply: "We open at 9. What day works for you?", service: "Braces", requestedTime: "" };
        return Response.json({ choices: [{ message: { content: JSON.stringify(draft) } }] });
      }
      assert.equal(options.headers.Authorization, "Bearer page-key");
      const request = new URL(url);
      assert.equal(request.searchParams.get("appsecret_proof"),
        createHmac("sha256", "app-secret").update("page-key").digest("hex"));
      assert.ok(!request.searchParams.has("access_token"));
      if (request.pathname.endsWith("/me")) return Response.json({ id: pageId });
      if (request.pathname.endsWith("/subscribed_apps")) return Response.json({ data: [{ id: appId, subscribed_fields: ["messages"] }] });
      assert.ok(request.pathname.endsWith(pageId + "/messages"));
      sends.push(JSON.parse(options.body));
      return sendFails ? new Response(null, { status: 503 }) : Response.json({ message_id: "sent" });
    }
  });
  return { make, turns, cases, sends, modelInputs, route, commentPilot,
    disconnect: () => { connected = false; }, touch: (action = { action: "claimed" }) => { staffAction = action; },
    failSend: () => { sendFails = true; } };
}

test("clinic Page config cannot replace Eden's Page or point to an invalid tenant", () => {
  assert.equal(parseClinicPages(undefined, pageId).size, 0);
  assert.throws(() => parseClinicPages(JSON.stringify({ [pageId]: page }), pageId));
  assert.throws(() => parseClinicPages(JSON.stringify({ [pageId]: { ...page, locationId: "other" } }), "999999"));
});

test("Messenger uses the confirmed facts and respects the clinic's appointment handling", async () => {
  const f = fixture();
  f.route.location.messenger_facts = { services: "Dental exam", hours: "10–4", bookingMode: "information" };
  const messenger = f.make();
  await messenger.processPayload(payload("hours-confirmed", "What hours are you open?"));
  await messenger.processPayload(payload("no-booking", "Please book Saturday at 2 PM"));
  assert.match(f.modelInputs[0].messages[0].content, /Dental exam/);
  assert.doesNotMatch(f.modelInputs[0].messages[0].content, /Open 9–5/);
  assert.match(f.sends[1].message.text, /contact the clinic team to request an appointment/);
  assert.equal(f.cases.size, 0);
});

test("a signed Messenger setup test becomes one sample only after Meta accepts the reply", async () => {
  const recognize = text => text === "EDEN SETUP TEST signed" ? "setup-one" : null;
  const f = fixture(null, recognize);
  f.route.location.messenger_facts = { hours: "10–4" };
  const messenger = f.make();
  await messenger.processPayload(payload("invalid-test", "EDEN SETUP TEST invalid"));
  assert.equal(f.sends.length, 0);
  await messenger.processPayload(payload("test-first", "EDEN SETUP TEST signed"));
  await f.make().processPayload(payload("test-resend", "EDEN SETUP TEST signed"));
  assert.equal(f.sends.length, 1);
  const reply = f.sends[0].message.text;
  const [instruction, link] = reply.split("\n\n");
  assert.equal(instruction, "Eden received your test message and replied successfully. Open your setup page below to see the result.");
  const setupUrl = new URL(link);
  assert.equal(setupUrl.origin + setupUrl.pathname, "https://clinicnet.live/clinic/");
  assert.deepEqual(Object.fromEntries(setupUrl.searchParams), { messengerTest: "setup-one", account: accountId, location: locationId });
  assert.doesNotMatch(reply, /EDEN SETUP TEST signed|page-key/);
  assert.equal(f.modelInputs.length, 0);
  assert.equal(f.route.status, "connected");
  assert.equal(f.cases.size, 1);
  const [sample] = f.cases.values();
  assert.equal(sample.details.demo, true);
  assert.equal(sample.details.messengerSetupTestId, "setup-one");
  assert.equal(sample.details.senderId, undefined);
  assert.equal(sample.notify_to, null);

  const failed = fixture(null, recognize);
  failed.route.location.messenger_facts = { hours: "10–4" };
  failed.failSend();
  await failed.make().processPayload(payload("test-failed", "EDEN SETUP TEST signed"));
  assert.equal(failed.cases.size, 0);
  assert.equal(failed.route.status, "verifying");
});

test("only a verified binding receives replies and a conversation creates one booking request", async () => {
  const f = fixture(), messenger = f.make();
  assert.equal(await messenger.verifyPage(pageId, page), true);
  await messenger.processPayload(payload("stale", "Hi", timestamp - 86400000));
  await messenger.processPayload(payload("foreign", "Hi", timestamp, "12349999"));
  assert.equal(f.sends.length, 0);
  await messenger.processPayload(payload("hello", "I want braces"));
  assert.equal(f.route.status, "verifying");
  const second = payload("booking", "Please book Saturday at 2 PM", timestamp + 500);
  await Promise.all([messenger.processPayload(second), messenger.processPayload(second)]);
  await f.make().processPayload(second);
  assert.equal(f.route.status, "connected");
  assert.equal(f.sends.length, 2);
  assert.equal(f.modelInputs.length, 2);
  assert.equal(f.sends[1].messaging_type, "RESPONSE");
  assert.match(f.sends[1].message.text, /The clinic team will confirm the appointment here/);
  assert.equal(f.cases.size, 1);
  const [request] = f.cases.values();
  assert.equal(request.channel, "facebook_messenger");
  assert.equal(request.kind, "booking.requested");
  assert.equal(request.account_id, accountId);
  assert.equal(request.location_id, locationId);
  assert.equal(request.details.requestedTime, "Saturday at 2 PM");
  assert.equal(request.details.service, "Braces");
  assert.equal(request.notify_to, "clinic@example.test");
  await messenger.processPayload(payload("while-open", "Any update?", timestamp + 800));
  assert.equal(f.sends.length, 3);
  assert.equal(f.cases.size, 1);
  f.disconnect();
  await messenger.processPayload(payload("unapproved", "Hi", timestamp + 900));
  assert.equal(f.sends.length, 3);
});

test("one connected post produces review-only drafts and tags a later Messenger booking", async () => {
  const postId = `${pageId}_1234567`;
  const config = parseCommentPilot(JSON.stringify({ pageId, postId }));
  assert.throws(() => parseCommentPilot(JSON.stringify({ pageId, postId: "987654321_1234567" })));
  const f = fixture(config), messenger = f.make();
  const comment = { item: "comment", verb: "add", post_id: postId, parent_id: "1234567",
    comment_id: "1234567_1234568", sender_id: sender, created_time: timestamp / 1000,
    message: "How much for braces? My number is 09000000000." };
  const changes = [
    comment, comment,
    { ...comment, comment_id: "1234567_1234569", from: { id: pageId } },
    { ...comment, comment_id: "1234567_1234570", parent_id: comment.comment_id },
    { ...comment, comment_id: "1234567_1234571", post_id: `${pageId}_1234569` },
    { ...comment, comment_id: "1234567_1234572", verb: "edited" }
  ].map(value => ({ field: "feed", value }));
  const feed = { object: "page", entry: [{ id: pageId, changes }] };
  await f.commentPilot.processPayload(feed);
  assert.equal(f.cases.size, 0);
  f.route.status = "connected";
  await Promise.all([f.commentPilot.processPayload(feed), f.commentPilot.processPayload(feed)]);
  assert.equal(f.cases.size, 1);
  assert.equal(f.sends.length, 0);
  const [review] = f.cases.values();
  assert.equal(review.status, "staff_review");
  assert.equal(review.location_id, locationId);
  assert.match(review.details.publicDraft, /pricing question/);
  assert.doesNotMatch(JSON.stringify(review), /09000000000|How much for braces/);
  const code = review.details.commentPilotCode;

  await messenger.processPayload(payload("unknown-tag", "EDEN-FFFFFFFFFF"));
  assert.equal(f.cases.size, 1);
  const tagged = payload("known-tag", `${code} I want braces`, timestamp + 100);
  await messenger.processPayload(tagged);
  await f.make().processPayload(tagged);
  assert.equal(f.cases.size, 2);
  const modelMessage = JSON.parse(f.modelInputs.at(-1).messages.at(-1).content);
  assert.equal(modelMessage.message, "I want braces");
  await messenger.processPayload(payload("booking", "Please book Saturday at 2 PM", timestamp + 200));
  const [draft, conversation, booking] = f.cases.values();
  assert.equal(draft.kind, "comment.draft");
  assert.equal(conversation.kind, "comment.messenger_started");
  assert.equal(booking.kind, "booking.requested");
  assert.equal(booking.details.commentPilotPostId, postId);
  assert.equal(booking.details.commentPilotCode, code);
  assert.equal(booking.details.requestedTime, "Saturday at 2 PM");
});

test("attachments hand off, and a rejected send is never retried after restart", async () => {
  const f = fixture(), messenger = f.make();
  await messenger.processPayload(payload("attachment", ""));
  assert.equal(f.modelInputs.length, 0);
  assert.equal([...f.cases.values()][0].kind, "inquiry.followup_needed");
  await messenger.processPayload(payload("pending", "Are you there?", timestamp + 100));
  assert.equal(f.sends.length, 2);
  f.failSend();
  const message = payload("failed", "Hi", timestamp + 500);
  await messenger.processPayload(message);
  await f.make().processPayload(message);
  assert.equal(f.sends.length, 3);
  assert.equal(f.cases.size, 2);
  assert.equal([...f.turns.values()].at(-1).state, "needs_review");
});

test("Page verification identifies the failing check without exposing Meta error text", async () => {
  const make = failAt => createClinicMessenger({
    pages: new Map(), appId, appSecret: "app-secret",
    async fetchImpl(url) {
      const identity = new URL(url).pathname.endsWith("/me");
      if (identity && failAt === "subscription") return Response.json({ id: pageId });
      return Response.json({ error: { code: 190, error_subcode: 463, message: "do not log this" } }, { status: 400 });
    }
  });
  await assert.rejects(make("identity").verifyPage(pageId, page), {
    message: "Page token identity check: Meta request failed: HTTP 400, code 190, subcode 463"
  });
  await assert.rejects(make("subscription").verifyPage(pageId, page), {
    message: "Page webhook subscription check: Meta request failed: HTTP 400, code 190, subcode 463"
  });
});

test("Page verification logs only a fixed hint for a rejected app secret proof", async () => {
  const messenger = createClinicMessenger({
    pages: new Map(), appId, appSecret: "app-secret",
    async fetchImpl() {
      return Response.json({ error: {
        code: 100, message: "Invalid appsecret_proof provided in the API argument: do not log this"
      } }, { status: 400 });
    }
  });
  await assert.rejects(messenger.verifyPage(pageId, page), {
    message: "Page token identity check: Meta request failed: HTTP 400, code 100, subcode none, app secret proof rejected"
  });
});

test("Messenger recovers the visitor’s original date and time when the model invents a year", async () => {
  const f = fixture(null, null, () => ({
    intent: "booking", reply: "Untrusted wording", service: "Dental cleaning", requestedTime: "2023-11-19T15:15:00"
  }));
  f.route.location.timezone = "Asia/Manila";
  await f.make().processPayload(payload("exact-time", "Hi, could I book a dental cleaning for Thursday, November 19 at 3:15 PM Cebu time?"));
  assert.equal([...f.cases.values()][0].details.requestedTime, "Thursday, November 19 at 3:15 PM");
  assert.match(f.modelInputs[0].messages[0].content, /Asia\/Manila/);
  assert.match(f.sends[0].message.text, /request for Thursday, November 19 at 3:15 PM/);
});

test("Messenger asks for clarification when an invented year cannot be grounded", async () => {
  const f = fixture(null, null, () => ({
    intent: "booking", reply: "Untrusted wording", service: "Dental cleaning", requestedTime: "2023-11-19T15:15:00"
  }));
  await f.make().processPayload(payload("ungrounded-date", "Can I book a cleaning next Thursday?"));
  assert.equal(f.cases.size, 0);
  assert.match(f.sends[0].message.text, /What date works for you/);
});

test("Messenger carries the selected day across turns and logs one exact clinic-local request", async () => {
  const f = fixture(null, null, input => {
    if (input.message === "Pwede cleaning Thursday afternoon?") {
      return { intent: "answer", reply: "Pwede. What time Thursday afternoon works for you?",
        service: "Cleaning", requestedDay: "Thursday", requestedClock: "" };
    }
    assert.equal(input.priorService, "Cleaning");
    assert.equal(input.priorPreference.requestedDay, "Thursday");
    return { intent: "booking", reply: "Your slot is guaranteed", replyLanguage: "ceb",
      service: input.priorService, requestedDay: input.priorPreference.requestedDay, requestedClock: "3:15 PM" };
  });
  f.route.location.timezone = "Asia/Manila";
  await f.make().processPayload(payload("date-only", "Pwede cleaning Thursday afternoon?"));
  assert.equal(f.cases.size, 0);
  assert.match(f.sends[0].message.text, /What time Thursday afternoon/);
  const second = payload("date-and-clock", "3:15 PM please", timestamp + 800);
  const messenger = f.make();
  await Promise.all([messenger.processPayload(second), messenger.processPayload(second)]);
  assert.equal(f.cases.size, 1);
  assert.equal(f.sends.length, 2);
  assert.equal([...f.cases.values()][0].details.requestedTime, "Thursday, November 12, 2026 at 3:15 PM");
  assert.match(f.sends[1].message.text, /^Sige\. I’ve passed along your request/);
  assert.match(f.sends[1].message.text, /clinic team will confirm/);
  assert.doesNotMatch(f.sends[1].message.text, /guaranteed/);
});

test("Messenger gives exploratory and hesitant visitors room to decide", async () => {
  const f = fixture(null, null, input => input.message === "How much is a cleaning?" ?
    { intent: "answer", reply: "Cleaning starts at ₱800. What would you like to know about the visit?", service: "Cleaning" } :
    { intent: "answer", reply: "Of course. Take your time." });
  f.route.location.messenger_facts = { services: "Cleaning starts at ₱800", bookingMode: "requests" };
  const messenger = f.make();
  await messenger.processPayload(payload("curious", "How much is a cleaning?"));
  await messenger.processPayload(payload("hesitant", "I’ll think about it", timestamp + 800));
  assert.equal(f.cases.size, 0);
  assert.match(f.modelInputs[0].messages[0].content, /Answer the visitor's actual question first/);
  assert.match(f.modelInputs[0].messages[0].content, /low-pressure next step/);
  assert.equal(f.modelInputs[1].messages.at(-2).role, "assistant");
  assert.match(f.sends[0].message.text, /starts at ₱800/);
  assert.equal(f.sends[1].message.text, "Of course. Take your time.");
});

test("Messenger requires an unambiguous time or an explicit flexible request", async () => {
  for (const [message, fields, expected] of [
    ["Cleaning Thursday at 3?", { requestedDay: "Thursday", requestedClock: "3 PM" }, null],
    ["Cleaning Thursday at 3:03 PM?", { requestedDay: "Thursday", requestedClock: "03 PM" }, "Thursday at 3:03 PM"],
    ["Please book a cleaning next Thursday at 3 PM", { requestedDay: "next Thursday", requestedClock: "3 PM" }, null],
    ["Book a cleaning Thursday or Friday afternoon", { requestedDay: "Thursday", flexibility: "any time" }, null],
    ["Please book a cleaning, I'm flexible", { flexibility: "I'm flexible" }, "I'm flexible"],
    ["Can't do Thursday at 3 PM. Could you book Friday?", { requestedDay: "Friday", requestedClock: "" }, null]
  ]) {
    const f = fixture(null, null, () => ({ intent: "booking", reply: "Untrusted wording", service: "Cleaning", ...fields }));
    await f.make().processPayload(payload("preference", message));
    if (expected === null) {
      assert.equal(f.cases.size, 0, message);
      assert.match(f.sends[0].message.text, /What (date|time) works/, message);
    } else {
      assert.equal([...f.cases.values()][0].details.requestedTime, expected, message);
    }
  }
});

test("Messenger carries the corrected time forward and hands clinical questions to staff", async () => {
  const f = fixture(null, null, input => {
    if (input.message === "Please check cleaning on Thursday at 3 PM") {
      return { intent: "answer", reply: "I can send that to the team. Shall I?", service: "Cleaning",
        requestedDay: "Thursday", requestedClock: "3 PM" };
    }
    if (input.message === "Yes, but make it 4:30 PM") {
      assert.equal(input.priorPreference.requestedClock, "3 PM");
      return { intent: "booking", reply: "Untrusted wording", service: "Cleaning",
        requestedDay: input.priorPreference.requestedDay, requestedClock: "4:30 PM" };
    }
    return { intent: "handoff", reply: "I’ll ask the clinic team to help with that." };
  });
  const messenger = f.make();
  await messenger.processPayload(payload("original-clock", "Please check cleaning on Thursday at 3 PM"));
  await messenger.processPayload(payload("corrected-clock", "Yes, but make it 4:30 PM", timestamp + 500));
  assert.equal([...f.cases.values()][0].details.requestedTime, "Thursday at 4:30 PM");
  await messenger.processPayload(payload("handoff", "Could I speak to someone about a clinical concern?", timestamp + 800));
  assert.equal([...f.cases.values()][1].kind, "inquiry.followup_needed");
});


test("Messenger honors a clear deferral even when a complete preference is on record", async () => {
  const f = fixture(null, null, input => ({
    intent: input.message === "Maybe later." ? "booking" : "answer",
    reply: "I can pass that request to the team. Shall I?",
    service: "Cleaning", requestedDay: "Fri", requestedClock: "3:15 PM"
  }));
  const messenger = f.make();
  await messenger.processPayload(payload("tentative", "Is a cleaning on Fri at 3:15 PM an option?"));
  await messenger.processPayload(payload("defer", "Maybe later.", timestamp + 800));
  assert.equal(f.cases.size, 0);
  assert.equal(f.sends[1].message.text, "Of course. Take your time.");
});

test("Messenger keeps the requested cleaning when a time-only reply is mistaken for a checkup choice", async () => {
  const f = fixture(null, null, input => {
    if (input.message.includes("nervous")) {
      return { intent: "answer", reply: "We can take it at your pace. I can ask about a cleaning. What time Thursday afternoon works for you?",
        service: "Cleaning", requestedDay: "Thursday" };
    }
    assert.equal(input.priorService, "Cleaning");
    assert.equal(input.priorServiceNeedsCheck, true);
    return { intent: "booking", reply: "You’re booked for a checkup.",
      service: "Checkup", serviceSelected: true, requestedDay: input.priorPreference.requestedDay, requestedClock: "4:15 PM" };
  });
  f.route.location.timezone = "Asia/Manila";
  f.route.location.messenger_facts = { services: "Dental check-up and consultations", bookingMode: "request" };
  const messenger = f.make();
  await messenger.processPayload(payload("cleaning-request", "I'm nervous. Could I come in for a cleaning Thursday afternoon?"));
  await messenger.processPayload(payload("time-only", "4:15 PM Cebu time ok?", timestamp + 500));
  assert.match(f.sends[0].message.text, /take it at your pace/);
  assert.match(f.sends[1].message.text, /check on cleaning.*at 4:15 PM/);
  assert.doesNotMatch(f.sends[1].message.text, /booked|checkup/);
  assert.equal(f.cases.size, 1);
  const [request] = f.cases.values();
  assert.equal(request.kind, "inquiry.followup_needed");
  assert.equal(request.details.service, "Cleaning");
  assert.equal(request.details.requestedTime, "Thursday, November 12, 2026 at 4:15 PM");
});

test("Messenger books a different approved service when the visitor clearly chooses it", async () => {
  const f = fixture(null, null, input => {
    if (!input.priorService) return { intent: "answer", reply: "I can ask the team about a cleaning.",
      service: "Cleaning", serviceNeedsCheck: true, requestedDay: "Thursday", requestedClock: "4:15 PM" };
    return { intent: "booking", reply: "I’ll send that to the team.",
      service: "Checkup", serviceSelected: true, ...input.priorPreference };
  });
  f.route.location.messenger_facts = { services: "Dental check-ups and consultations", bookingMode: "request" };
  const messenger = f.make();
  await messenger.processPayload(payload("original-service", "Could I request a cleaning Thursday at 4:15 PM?"));
  await messenger.processPayload(payload("explicit-change", "I'd prefer a check-up.", timestamp + 500));
  assert.equal(f.cases.size, 1);
  const [request] = f.cases.values();
  assert.equal(request.kind, "booking.requested");
  assert.equal(request.details.service, "Checkup");
  assert.equal(request.details.requestedTime, "Thursday at 4:15 PM");
});

test("an unlisted service stays in intake until the visitor supplies an exact time", async () => {
  const f = fixture(null, null, input => {
    if (!input.priorService) {
      return { intent: "handoff", handoffReason: "service_verification", service: "Cleaning", requestedDay: "Thursday",
        reply: "I’ll check with the team. Can I help with anything else?" };
    }
    assert.equal(input.priorPreference.requestedDay, "Thursday");
    return { intent: "booking", service: "Cleaning", requestedDay: "Thursday", requestedClock: "4:15 PM",
      reply: "The team will check that for you." };
  });
  f.route.location.timezone = "Asia/Manila";
  f.route.location.messenger_facts = { services: "Checkup and consultation", bookingMode: "request" };
  const messenger = f.make();
  await messenger.processPayload(payload("incomplete-cleaning", "I’m a bit nervous. Could I come in for a cleaning Thursday afternoon?"));
  assert.equal(f.cases.size, 0);
  assert.match(f.sends[0].message.text, /ask the team about cleaning.*What time works/);
  await messenger.processPayload(payload("completed-cleaning", "Can I simply book now 4:15 PM Cebu time?", timestamp + 800));
  assert.equal(f.cases.size, 1);
  const [request] = f.cases.values();
  assert.equal(request.kind, "inquiry.followup_needed");
  assert.equal(request.details.service, "Cleaning");
  assert.equal(request.details.requestedTime, "Thursday, November 12, 2026 at 4:15 PM");
});

test("a request for a person still hands off immediately for an unlisted service", async () => {
  const f = fixture(null, null, () => ({
    intent: "handoff", handoffReason: "staff_requested", service: "Cleaning", requestedDay: "Thursday",
    reply: "I’ll ask someone from the clinic to help you here."
  }));
  f.route.location.messenger_facts = { services: "Checkup and consultation", bookingMode: "request" };
  await f.make().processPayload(payload("person-requested", "Could I speak to someone about a cleaning Thursday?"));
  assert.equal(f.cases.size, 1);
  assert.equal([...f.cases.values()][0].kind, "inquiry.followup_needed");
  assert.match(f.sends[0].message.text, /ask someone from the clinic/);
});

test("Cebu's 4:15 PM reply completes the requested Thursday despite missing model fields", async () => {
  const start = Date.parse("2026-11-16T05:05:00Z");
  const f = fixture(null, null, input => {
    if (input.message.includes("nervous")) {
      return { intent: "answer", service: "Cleaning", serviceNeedsCheck: true,
        reply: "We can take it at your pace. I can ask the team about a cleaning. What time Thursday afternoon works for you?" };
    }
    if (input.message.startsWith("4:15")) {
      return { intent: "answer", service: "Cleaning", requestedClock: "4:15 PM",
        reply: "Thanks for sharing your preferred time! I'll check with the team about a cleaning. What day works for you?" };
    }
    return { intent: "answer", requestedDay: "Thursday", reply: "What time on Thursday works for you?" };
  });
  f.route.location.timezone = "Asia/Manila";
  f.route.location.messenger_facts = { services: "Checkup and consultation", bookingMode: "request" };
  clock.now = start + 2000;
  try {
    await f.make().processPayload(payload("cebu-nervous",
      "Hi, I haven’t been to the dentist in a while and I’m a bit nervous. Could I come in for a cleaning Thursday afternoon?", start));
    assert.equal(f.cases.size, 0);
    await f.make().processPayload(payload("cebu-clock", "4:15 PM Cebu time.", start + 500));
    assert.equal(f.cases.size, 1);
    assert.match(f.sends[1].message.text, /cleaning.*Thursday, November 19, 2026 at 4:15 PM/);
    assert.equal([...f.cases.values()][0].details.requestedTime, "Thursday, November 19, 2026 at 4:15 PM");
    await f.make().processPayload(payload("cebu-repeat-day", "Thursday", start + 1000));
    assert.equal(f.cases.size, 1);
    assert.equal(f.sends.length, 3);
    assert.match(f.sends[2].message.text, /clinic team has your request/);
  } finally {
    clock.now = timestamp + 1000;
  }
});

test("Messenger reads both sides of the last eight exchanges in the same thread only", async () => {
  const f = fixture(null, null, () => ({ intent: "answer", reply: "Happy to help." }));
  const messenger = f.make();
  for (let i = 0; i < 11; i++) {
    await messenger.processPayload(payload("history-" + i, "Clinic question " + i, timestamp + i));
  }
  const recent = f.modelInputs.at(-1).messages.slice(1, -1);
  assert.equal(recent.length, 16);
  assert.deepEqual(recent.filter(message => message.role === "user").map(message => message.content),
    Array.from({ length: 8 }, (_, index) => "Clinic question " + (index + 2)));
  assert.ok(recent.filter(message => message.role === "assistant").every(message => message.content === "Happy to help."));

  const anotherVisitor = payload("separate-thread", "Different visitor", timestamp + 20);
  anotherVisitor.entry[0].messaging[0].sender.id = "5555512346";
  await messenger.processPayload(anotherVisitor);
  assert.equal(f.modelInputs.at(-1).messages.length, 2);

  const nextSession = timestamp + 25 * 60 * 60 * 1000;
  clock.now = nextSession;
  try {
    await messenger.processPayload(payload("next-session", "Hello again", nextSession));
    assert.equal(f.modelInputs.at(-1).messages.length, 2);
  } finally {
    clock.now = timestamp + 1000;
  }
});

test("Messenger keeps a time supplied first and recognizes a corrected repetition of Thursday", async () => {
  const f = fixture(null, null, input => ({ intent: "answer", service: "Cleaning",
    requestedClock: input.priorBookingIntent ? "" : "4:15 PM", reply: "What day works for you?" }));
  f.route.location.timezone = "Asia/Manila";
  const messenger = f.make();
  await messenger.processPayload(payload("time-first", "Could I book a cleaning at 4:15 PM Cebu time?"));
  await messenger.processPayload(payload("day-next", "I already mentioned Thrusday", timestamp + 500));
  assert.equal(f.cases.size, 1);
  assert.equal([...f.cases.values()][0].details.requestedTime, "Thursday, November 12, 2026 at 4:15 PM");
});

test("a remembered day and a new split time cannot create a request in the past", async () => {
  const f = fixture(null, null, () => ({ intent: "answer", service: "Cleaning", reply: "What time?" }));
  f.route.location.timezone = "Asia/Manila";
  const messenger = f.make();
  await messenger.processPayload(payload("today", "Could I book a cleaning today?"));
  await messenger.processPayload(payload("past-clock", "4:15 PM Cebu time.", timestamp + 500));
  assert.equal(f.cases.size, 0);
  assert.match(f.sends[1].message.text, /already passed/);
});

test("after booking, FAQs are answered and an untouched request is amended once even after restart", async () => {
  const f = fixture(null, null, input => {
    if (input.message.startsWith("Please book")) {
      return { intent: "booking", service: "Cleaning", requestedDay: "Thursday", requestedClock: "4:15 PM", reply: "Request sent." };
    }
    assert.equal(input.submittedRequest.service, "Cleaning");
    if (input.message === "Where are you?") {
      return { intent: "answer", reply: "We’re next to the main entrance." };
    }
    return { intent: "handoff", requestAction: "change_time", requestedClock: "5 PM", reply: "I can ask the team." };
  });
  f.route.location.timezone = "Asia/Manila";
  const messenger = f.make();
  await messenger.processPayload(payload("initial-booking", "Please book cleaning Thursday at 4:15 PM"));
  await messenger.processPayload(payload("location-question", "Where are you?", timestamp + 200));
  assert.equal(f.sends[1].message.text, "We’re next to the main entrance.");
  assert.equal(f.cases.size, 1);

  const change = payload("change-time", "Could we move it to 5 PM?", timestamp + 500);
  await f.make().processPayload(change);
  await f.make().processPayload(change);
  const [request] = f.cases.values();
  assert.equal(request.details.requestedTime, "Thursday, November 12, 2026 at 5 PM");
  assert.equal(request.details.messengerAmendments.length, 1);
  assert.equal(f.sends.length, 3);
  assert.equal(f.cases.size, 1);
  assert.match(f.sends[2].message.text, /confirm the change here/);
});

test("after staff touches a request, changes, cancellation and a staff question are separate linked tasks", async () => {
  const f = fixture(null, null, input => {
    if (input.message.startsWith("Please book")) {
      return { intent: "booking", service: "Cleaning", requestedDay: "Thursday", requestedClock: "4:15 PM", reply: "Request sent." };
    }
    if (input.message.startsWith("Could we move")) {
      return { intent: "handoff", requestAction: "change_time", requestedClock: "5 PM", reply: "I can ask the team." };
    }
    if (input.message.startsWith("Could we do")) {
      return { intent: "handoff", requestAction: "change_service", service: "Check-up", reply: "I can ask the team." };
    }
    if (input.message === "What’s your cancellation policy?") {
      return { intent: "answer", reply: "We ask for one day's notice." };
    }
    if (input.message.includes("cancel")) {
      return { intent: "handoff", requestAction: "cancel", reply: "I can ask the team." };
    }
    return { intent: "handoff", requestAction: "follow_up", reply: "Let me ask the team." };
  });
  f.route.location.timezone = "Asia/Manila";
  const messenger = f.make();
  await messenger.processPayload(payload("staff-original", "Please book cleaning Thursday at 4:15 PM"));
  f.touch();
  await messenger.processPayload(payload("staff-question", "Can someone check if my insurance covers this?", timestamp + 100));
  await messenger.processPayload(payload("staff-time", "Could we move it to 5 PM?", timestamp + 200));
  await messenger.processPayload(payload("staff-service", "Could we do a check-up instead?", timestamp + 300));
  await messenger.processPayload(payload("staff-cancel-policy", "What’s your cancellation policy?", timestamp + 500));
  await messenger.processPayload(payload("staff-cancel", "Please cancel it", timestamp + 600));
  await messenger.processPayload(payload("staff-cancel-repeat", "Please cancel it", timestamp + 700));

  const [original, question, time, service, cancellation] = f.cases.values();
  assert.equal(f.cases.size, 5);
  assert.equal(original.details.requestedTime, "Thursday, November 12, 2026 at 4:15 PM");
  assert.equal(original.details.service, "Cleaning");
  assert.deepEqual([question, time, service, cancellation].map(event => event.details.messengerRequestAction),
    ["follow_up", "change_time", "change_service", "cancel"]);
  assert.ok([question, time, service, cancellation].every(event => event.kind === "inquiry.followup_needed" &&
    event.details.relatedRequestKey === original.event_key));
  assert.equal(time.details.requestedTime, "Thursday, November 12, 2026 at 5 PM");
  assert.equal(service.details.service, "Check-up");
  assert.equal(f.sends[4].message.text, "We ask for one day's notice.");
  assert.match(f.sends[5].message.text, /cancellation request/);
});

test("Messenger can recall the same thread's submitted request on a later day without the old transcript", async () => {
  const f = fixture(null, null, input => {
    if (input.message.startsWith("Please book")) {
      return { intent: "booking", service: "Cleaning", requestedDay: "Thursday", requestedClock: "4:15 PM", reply: "Request sent." };
    }
    assert.equal(input.submittedRequest.service, "Cleaning");
    return { intent: "handoff", requestAction: "cancel", reply: "I can ask the team." };
  });
  await f.make().processPayload(payload("past-session-booking", "Please book cleaning Thursday at 4:15 PM"));
  const later = timestamp + 2 * 86400000;
  clock.now = later;
  try {
    await f.make().processPayload(payload("past-session-cancel", "Please cancel my request.", later));
    assert.equal(f.modelInputs[1].messages.length, 2);
    const [original, cancellation] = f.cases.values();
    assert.equal(cancellation.details.relatedRequestKey, original.event_key);
  } finally {
    clock.now = timestamp + 1000;
  }
});

test("a time change can collect the missing hour on the next message", async () => {
  const f = fixture(null, null, input => {
    if (input.message.startsWith("Please book")) {
      return { intent: "booking", service: "Cleaning", requestedDay: "Thursday", requestedClock: "4:15 PM", reply: "Request sent." };
    }
    if (input.message.startsWith("Move")) return { intent: "handoff", requestAction: "change_time",
      requestedDay: "Friday, November 13", reply: "I can ask the team." };
    return { intent: "answer", reply: "Which day?" };
  });
  f.route.location.timezone = "Asia/Manila";
  const messenger = f.make();
  await messenger.processPayload(payload("two-part-original", "Please book cleaning Thursday at 4:15 PM"));
  await messenger.processPayload(payload("two-part-amendment", "Move it to Friday, November 13 in the afternoon.", timestamp + 100));
  assert.match(f.sends[1].message.text, /What time/);
  await messenger.processPayload(payload("two-part-clock", "4:30 PM Cebu time.", timestamp + 200));
  assert.equal(f.cases.size, 1);
  assert.equal([...f.cases.values()][0].details.requestedTime, "Friday, November 13, 2026 at 4:30 PM");
});

test("a time-only change after booking uses the day staff actually confirmed", async () => {
  const f = fixture(null, null, input => input.message.startsWith("Please book")
    ? { intent: "booking", service: "Cleaning", requestedDay: "Thursday", requestedClock: "4:15 PM", reply: "Request sent." }
    : { intent: "handoff", requestAction: "change_time", requestedClock: "5 PM", reply: "I can ask the team." });
  f.route.location.timezone = "Asia/Manila";
  const messenger = f.make();
  await messenger.processPayload(payload("confirmed-root", "Please book cleaning Thursday at 4:15 PM"));
  f.touch({ action: "booked", appointment_at: "2026-11-13T08:15:00Z" });
  await messenger.processPayload(payload("confirmed-change", "Could we move it to 5 PM?", timestamp + 500));
  const [original, change] = f.cases.values();
  assert.equal(change.details.relatedRequestKey, original.event_key);
  assert.equal(change.details.requestedTime, "Friday, November 13, 2026 at 5 PM");
});

test("the Cebu 5 PM follow-up finds a saved date behind an undated inquiry and asks before creating a new request", async () => {
  const start = Date.parse("2026-11-16T05:05:00Z");
  const f = fixture(null, null, input => {
    if (input.message.startsWith("Could I book")) return { intent: "handoff", service: "Cleaning",
      requestedDay: "Thursday", reply: "The clinic team can help check the cleaning service." };
    if (input.message === "Where are you located?") return { intent: "answer", reply: "We’re in Cebu." };
    return null;
  });
  f.route.location.timezone = "Asia/Manila";
  clock.now = start + 3000;
  try {
    await f.make().processPayload(payload("date-from-earlier-request", "Could I book a cleaning Thursday?", start));
    await f.make().processPayload(payload("later-dateless", "Is anyone there?", start + 100));
    await f.make().processPayload(payload("address-before-time", "Where are you located?", start + 200));
    const [original, undated] = f.cases.values();
    assert.equal(original.details.requestedTime, "Thursday, November 19, 2026");
    assert.equal(undated.details.requestedTime, "");
    f.touch({ action: "handled" });
    await f.make().processPayload(payload("cebu-exact-change", "Could we move it to 5 PM?", start + 300));
    assert.equal(f.modelInputs.length, 3);
    assert.equal(f.cases.size, 2);
    assert.match(f.sends.at(-1).message.text, /earlier request is closed.*Thursday, November 19, 2026 at 5 PM/);
    await f.make().processPayload(payload("cebu-approve-new", "Yes please", start + 400));
    assert.equal(f.modelInputs.length, 3);
    assert.equal(f.cases.size, 3);
    const newRequest = [...f.cases.values()].at(-1);
    assert.equal(newRequest.details.requestedTime, "Thursday, November 19, 2026 at 5 PM");
    assert.equal(newRequest.details.service, "Cleaning");
    assert.equal(newRequest.details.relatedRequestKey, undefined);
    assert.equal(original.details.requestedTime, "Thursday, November 19, 2026");
  } finally {
    clock.now = timestamp + 1000;
  }
});

test("a clear time change asks for a calendar date when there is no anchored appointment", async () => {
  const f = fixture(null, null, () => null);
  f.route.location.timezone = "Asia/Manila";
  await f.make().processPayload(payload("no-appointment-on-file", "Could we move it to 5 PM?"));
  assert.equal(f.cases.size, 0);
  assert.equal(f.modelInputs.length, 0);
  assert.match(f.sends[0].message.text, /What calendar date should I use for 5 PM/);
  await f.make().processPayload(payload("missing-day", "Friday, November 13.", timestamp + 500));
  assert.equal(f.modelInputs.length, 0);
  assert.equal([...f.cases.values()][0].details.requestedTime, "Friday, November 13, 2026 at 5 PM");
});
