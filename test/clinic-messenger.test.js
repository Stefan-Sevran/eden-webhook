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

function fixture(commentConfig, readSetupTest) {
  const turns = new Map(), cases = new Map(), sends = [], modelInputs = [];
  const route = { account_id: accountId, location_id: locationId, status: "verifying", location: { alert_email: "clinic@example.test" } };
  let connected = true, closed = false, sendFails = false;
  const ledger = {
    async messengerLocation(id, config) {
      assert.equal(id, pageId); assert.equal(config.locationId, locationId);
      return connected ? route : null;
    },
    async activateMessengerConnection() { route.status = "connected"; },
    async messengerTurn(key) { return turns.get(key); },
    async recentMessengerTurn(key) {
      return [...turns.values()].reverse().find(turn => turn.conversation_key === key);
    },
    async messengerCaseOpen() { return !closed; },
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
        const input = JSON.parse(body.messages.at(-1).content);
        assert.deepEqual(input.clinicFacts, route.location.messenger_facts || page.facts);
        const draft = input.message === "Saturday please" ?
          { intent: "booking", reply: "Untrusted wording", service: input.priorService, requestedTime: "Saturday" } :
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
    disconnect: () => { connected = false; }, close: () => { closed = true; },
    failSend: () => { sendFails = true; } };
}

test("clinic Page config cannot replace Eden's Page or point to an invalid tenant", () => {
  assert.equal(parseClinicPages(undefined, pageId).size, 0);
  assert.throws(() => parseClinicPages(JSON.stringify({ [pageId]: page }), pageId));
  assert.throws(() => parseClinicPages(JSON.stringify({ [pageId]: { ...page, locationId: "other" } }), "999999"));
});

test("Messenger uses the confirmed facts and respects the clinic's appointment handling", async () => {
  const f = fixture();
  f.route.location.messenger_facts = { services: "Dental exam 500", hours: "10–4", address: "Cebu City, Philippines",
    bookingRules: "AI can confirm exams immediately", bookingMode: "information" };
  const messenger = f.make();
  await messenger.processPayload(payload("hours-confirmed", "What hours are you open?"));
  await messenger.processPayload(payload("no-booking", "Saturday please"));
  const [policy, input] = f.modelInputs[0].messages;
  assert.equal(JSON.parse(input.content).defaultCurrency, "PHP");
  assert.match(policy.content, /Clinic staff confirm all appointments/);
  assert.doesNotMatch(policy.content, /AI can confirm exams immediately/);
  assert.match(f.sends[1].message.text, /clinic team handles appointments/);
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
  const second = payload("booking", "Saturday please", timestamp + 500);
  await Promise.all([messenger.processPayload(second), messenger.processPayload(second)]);
  await f.make().processPayload(second);
  assert.equal(f.route.status, "connected");
  assert.equal(f.sends.length, 2);
  assert.equal(f.modelInputs.length, 2);
  assert.equal(JSON.parse(f.modelInputs[0].messages.at(-1).content).defaultCurrency, null);
  assert.equal(f.sends[1].messaging_type, "RESPONSE");
  assert.match(f.sends[1].message.text, /confirm the appointment with you/);
  assert.equal(f.cases.size, 1);
  const [request] = f.cases.values();
  assert.equal(request.channel, "facebook_messenger");
  assert.equal(request.kind, "booking.requested");
  assert.equal(request.account_id, accountId);
  assert.equal(request.location_id, locationId);
  assert.equal(request.details.requestedTime, "Saturday");
  assert.equal(request.details.service, "Braces");
  assert.equal(request.notify_to, "clinic@example.test");
  await messenger.processPayload(payload("while-open", "Any update?", timestamp + 800));
  assert.equal(f.sends.length, 2);
  f.disconnect();
  await messenger.processPayload(payload("unapproved", "Hi", timestamp + 900));
  assert.equal(f.sends.length, 2);
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
  await messenger.processPayload(payload("booking", "Saturday please", timestamp + 200));
  const [draft, conversation, booking] = f.cases.values();
  assert.equal(draft.kind, "comment.draft");
  assert.equal(conversation.kind, "comment.messenger_started");
  assert.equal(booking.kind, "booking.requested");
  assert.equal(booking.details.commentPilotPostId, postId);
  assert.equal(booking.details.commentPilotCode, code);
  assert.equal(booking.details.requestedTime, "Saturday");
});

test("attachments hand off, and a rejected send is never retried after restart", async () => {
  const f = fixture(), messenger = f.make();
  await messenger.processPayload(payload("attachment", ""));
  assert.equal(f.modelInputs.length, 0);
  assert.equal([...f.cases.values()][0].kind, "inquiry.followup_needed");
  await messenger.processPayload(payload("pending", "Are you there?", timestamp + 100));
  assert.equal(f.sends.length, 1);
  f.close(); f.failSend();
  const message = payload("failed", "Hi", timestamp + 500);
  await messenger.processPayload(message);
  await f.make().processPayload(message);
  assert.equal(f.sends.length, 2);
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
