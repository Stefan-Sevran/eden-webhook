const test = require("node:test");
const assert = require("node:assert/strict");
const { createClinicMessenger, parseClinicPages } = require("../clinic-messenger");

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

function fixture() {
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
  const make = () => createClinicMessenger({
    pages: new Map([[pageId, page]]), appId, ledger, openaiKey: "ai-key", now: () => clock.now,
    logger: { warn() {} },
    async recordOutcome(event) { if (!cases.has(event.event_key)) cases.set(event.event_key, event); },
    async fetchImpl(url, options) {
      if (url.includes("api.openai.com")) {
        const body = JSON.parse(options.body);
        modelInputs.push(body);
        assert.match(body.messages[0].content, /Pearl Dental[\s\S]*Open 9–5/);
        const input = JSON.parse(body.messages.at(-1).content);
        const draft = input.message === "Saturday please" ?
          { intent: "booking", reply: "Untrusted wording", service: input.priorService, requestedTime: "Saturday" } :
          { intent: "answer", reply: "We open at 9. What day works for you?", service: "Braces", requestedTime: "" };
        return Response.json({ choices: [{ message: { content: JSON.stringify(draft) } }] });
      }
      assert.equal(options.headers.Authorization, "Bearer page-key");
      if (url.endsWith("me?fields=id")) return Response.json({ id: pageId });
      if (url.endsWith("/subscribed_apps")) return Response.json({ data: [{ id: appId, subscribed_fields: ["messages"] }] });
      assert.ok(url.endsWith(pageId + "/messages"));
      sends.push(JSON.parse(options.body));
      return sendFails ? new Response(null, { status: 503 }) : Response.json({ message_id: "sent" });
    }
  });
  return { make, turns, cases, sends, modelInputs, route,
    disconnect: () => { connected = false; }, close: () => { closed = true; },
    failSend: () => { sendFails = true; } };
}

test("clinic Page config cannot replace Eden's Page or point to an invalid tenant", () => {
  assert.equal(parseClinicPages(undefined, pageId).size, 0);
  assert.throws(() => parseClinicPages(JSON.stringify({ [pageId]: page }), pageId));
  assert.throws(() => parseClinicPages(JSON.stringify({ [pageId]: { ...page, locationId: "other" } }), "999999"));
});

test("only a verified binding receives replies and a conversation creates one booking request", async () => {
  const f = fixture(), messenger = f.make();
  assert.equal(await messenger.verifyPage(pageId, page), true);
  await messenger.processPayload(payload("stale", "Hi", timestamp - 86400000));
  await messenger.processPayload(payload("foreign", "Hi", timestamp, "12349999"));
  assert.equal(f.sends.length, 0);
  await messenger.processPayload(payload("hello", "I want braces"));
  assert.equal(f.route.status, "connected");
  const second = payload("booking", "Saturday please", timestamp + 500);
  await Promise.all([messenger.processPayload(second), messenger.processPayload(second)]);
  await f.make().processPayload(second);
  assert.equal(f.sends.length, 2);
  assert.equal(f.modelInputs.length, 2);
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
    pages: new Map(), appId,
    async fetchImpl(url) {
      const identity = url.endsWith("me?fields=id");
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
