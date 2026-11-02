const assert = require("node:assert/strict");
const test = require("node:test");
const { voiceIdentity } = require("../voice-routing");
const { createOutcomeLedger, outcomeKey } = require("../outcome-ledger");

const accountId = "9e939ec0-b740-448e-8a92-886548e922e2";
const locationId = "e2395766-3859-4c89-b452-6f3a7a9f9422";
const agentId = "agent_8401kp8bt0jdf14rzzcv5veq94yg";

test("voice identity uses provider telephony destination, not payload clinic claims", () => {
  const data = { agent_id: agentId, conversation_id: "conv_123456789",
    clinicId: "other-clinic", accountId: "other-account",
    metadata: { phone_call: { direction: "inbound", agent_number: "+18005551234",
      external_number: "+14155552671" } } };
  assert.deepEqual(voiceIdentity(data), {
    agentId, conversationId: "conv_123456789", calledNumber: "+18005551234",
    caller: "+14155552671"
  });
  assert.equal(voiceIdentity({ ...data, metadata: { phone_call: {
    ...data.metadata.phone_call, direction: "outbound" } } }), null);
  assert.equal(voiceIdentity({ ...data, metadata: {} }), null);
});

test("voice route requires both agent and number, scopes tenant event and activates once", async () => {
  const calls = [];
  const ledger = createOutcomeLedger({ url: "https://db.example", key: "server-secret",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes("clinic_channel_connections?") && options.method === "PATCH") {
        return { ok: true, status: 200, json: async () => [{ id: "connection" }] };
      }
      if (url.includes("clinic_channel_connections?")) {
        const params = new URL(url).searchParams;
        return { ok: true, status: 200, json: async () =>
          params.get("external_id") === `eq.${agentId}` &&
          params.get("forwarding_number") === "eq.+18005551234" ? [{
            id: "connection", account_id: accountId, location_id: locationId,
            status: "verifying" }] : [] };
      }
      if (url.includes("clinic_locations?")) return { ok: true, status: 200,
        json: async () => [{ id: locationId, account_id: accountId,
          name: "Cebu Clinic", alert_email: "staff@example.com" }] };
      return { ok: true, status: 201, json: async () => [JSON.parse(options.body)] };
    }
  });
  assert.equal(await ledger.voiceLocation(agentId, "+19995551234"), null);
  const route = await ledger.voiceLocation(agentId, "+18005551234");
  assert.equal(route.location.name, "Cebu Clinic");
  const event = await ledger.record({
    event_key: outcomeKey("tenant_voice", agentId, "conv_123456789"),
    clinic_id: route.location.id, account_id: route.account_id,
    location_id: route.location.id, channel: "ai_phone", kind: "call.followup_needed",
    status: "AWAITING_CLINIC", summary: "Call to review",
    notify_to: route.location.alert_email
  });
  assert.equal(event.event.account_id, accountId);
  assert.equal(event.event.location_id, locationId);
  assert.equal(await ledger.activateVoiceConnection(route), true);
  assert.equal(JSON.parse(calls.at(-1).options.body).status, "connected");
  const wrong = calls.find(call => call.url.includes("forwarding_number=eq.%2B19995551234"));
  assert.ok(wrong);
});

test("voice provisioning only updates a requested connection in the same account", async () => {
  const requests = [];
  const ledger = createOutcomeLedger({ url: "https://db.example", key: "server-secret",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      const params = new URL(url).searchParams;
      if (url.includes("clinic_locations?")) return { ok: true, status: 200,
        json: async () => params.get("account_id") === `eq.${accountId}`
          ? [{ id: locationId }] : [] };
      return { ok: true, status: 200, json: async () => [{
        id: "connection", status: "verifying" }] };
    }
  });
  assert.equal(await ledger.provisionVoiceConnection("wrong", locationId,
    agentId, "+18005551234"), null);
  assert.equal(requests.length, 1);
  const result = await ledger.provisionVoiceConnection(accountId, locationId,
    agentId, "+18005551234");
  assert.equal(result.status, "verifying");
  const patch = requests.at(-1);
  assert.equal(new URL(patch.url).searchParams.get("status"), "in.(requested,action_required)");
  assert.equal(new URL(patch.url).searchParams.get("account_id"), `eq.${accountId}`);
  assert.equal(JSON.parse(patch.options.body).forwarding_number, "+18005551234");
});
