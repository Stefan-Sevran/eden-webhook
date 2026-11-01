const assert = require("node:assert/strict");
const test = require("node:test");
const { createHmac } = require("node:crypto");
const {
  createOutcomeLedger, outcomeKey, hasOpsAccess, parseAlertEmails
} = require("../outcome-ledger");
const { hasValidElevenSignature } = require("../eleven-signature");

test("outcome ledger stores distinct events, ignores a retry, and lists one clinic", async () => {
  const rows = new Map();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") {
      const event = JSON.parse(options.body);
      if (rows.has(event.event_key)) return { ok: true, status: 200, json: async () => [] };
      rows.set(event.event_key, event);
      return { ok: true, status: 201, json: async () => [event] };
    }
    return { ok: true, status: 200, json: async () =>
      [...rows.values()].filter(row => !url.includes("clinic_id=eq.") ||
        url.includes(`clinic_id=eq.${row.clinic_id}`)) };
  };
  const ledger = createOutcomeLedger({
    url: "https://db.example", key: "backend-only-secret", fetchImpl
  });
  const event = {
    event_key: outcomeKey("booking", "clinic-1", "lead-1", "awaiting"),
    clinic_id: "clinic-1", channel: "website_chat", kind: "booking.requested",
    status: "AWAITING_CLINIC", summary: "Booking requested",
    details: { patientName: "Patient" }
  };
  assert.equal((await ledger.record(event)).stored, true);
  assert.equal((await ledger.record(event)).stored, false);
  assert.equal((await ledger.list({ clinicId: "clinic-1" })).length, 1);
  assert.equal((await ledger.list({ clinicId: "clinic-2" })).length, 0);
  assert.equal(requests[0].options.headers.apikey, "backend-only-secret");
});

test("claimed notification sends one stable email and marks it sent", async () => {
  const eventKey = outcomeKey("call", "clinic-1", "call-1");
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/rpc/claim_clinic_notifications")) {
      return { ok: true, status: 200, json: async () => [{
        event_key: eventKey, clinic_id: "clinic-1", channel: "missed_call",
        kind: "call.followup_needed", status: "MISSED_CALL",
        summary: "Call to review", details: { contact: "+6300000000" },
        notify_to: "owner@example.com"
      }] };
    }
    if (url.includes("/emails")) {
      return { ok: true, status: 200, json: async () => ({ id: "email-1" }) };
    }
    return { ok: true, status: 204 };
  };
  const ledger = createOutcomeLedger({
    url: "https://db.example", key: "server-secret",
    resendKey: "resend-secret", fromEmail: "Eden <alerts@example.com>", fetchImpl
  });
  assert.deepEqual(await ledger.dispatch(), { claimed: 1, sent: 1, failed: 0 });
  const email = requests.find(request => request.url.includes("/emails"));
  assert.equal(email.options.headers["Idempotency-Key"], eventKey);
  assert.equal(JSON.parse(email.options.body).to[0], "owner@example.com");
  assert.equal(JSON.parse(requests.at(-1).options.body).notification_state, "sent");
});

test("operations key and clinic email mapping are validated", () => {
  assert.equal(hasOpsAccess("Bearer correct-key", "correct-key"), true);
  assert.equal(hasOpsAccess("Bearer wrong-key", "correct-key"), false);
  assert.equal(hasOpsAccess("Bearer correct-key", ""), false);
  assert.deepEqual(parseAlertEmails('{"clinic-1":"owner@example.com"}'),
    { "clinic-1": "owner@example.com" });
  assert.throws(() => parseAlertEmails('{"clinic-1":"not-email"}'));
});

test("ElevenLabs signature checks raw body and rejects stale deliveries", () => {
  const body = Buffer.from('{"data":{"conversation_id":"one"}}');
  const secret = "eleven-secret";
  const timestamp = 1793440000;
  const signature = createHmac("sha256", secret)
    .update(String(timestamp)).update(".").update(body).digest("hex");
  const header = `t=${timestamp},v0=${signature}`;
  assert.equal(hasValidElevenSignature(body, header, secret, timestamp + 10), true);
  assert.equal(hasValidElevenSignature(Buffer.from("{}"), header, secret, timestamp + 10), false);
  assert.equal(hasValidElevenSignature(body, header, secret, timestamp + 1801), false);
});
