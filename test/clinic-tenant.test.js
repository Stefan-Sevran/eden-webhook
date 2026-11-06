const test = require("node:test");
const assert = require("node:assert/strict");
const { createClinicTenantApi } = require("../clinic-tenant");

const accountId = "9e939ec0-b740-448e-8a92-886548e922e2";
const locationId = "e2395766-3859-4c89-b452-6f3a7a9f9422";
const userId = "911f7eda-e4e7-4caf-9d5d-913bddb315b5";

test("clinic requests verify identity and forward only a user token to RLS", async () => {
  const calls = [];
  const api = createClinicTenantApi({
    url: "https://project.supabase.co", publishableKey: "public-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/auth/v1/user")) {
        return { ok: true, json: async () => ({ id: userId }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    }
  });
  const identity = await api.authenticate("Bearer user-token");
  assert.deepEqual(identity, { token: "user-token", userId });
  const path = api.scopedPath("clinic_outcomes", accountId, { locationId });
  await api.request(identity.token, path);
  assert.match(calls[1].url, /account_id=eq\.9e939ec0/);
  assert.match(calls[1].url, /location_id=eq\.e2395766/);
  assert.equal(calls[1].options.headers.Authorization, "Bearer user-token");
  assert.equal(calls[1].options.headers.apikey, "public-key");
  assert.equal(await api.authenticate("" ).then(result => result.error), 401);
  assert.throws(() => api.scopedPath("clinic_outcomes", "other-account"),
    { status: 400 });
});

test("channel request cannot claim a connected state", async () => {
  const calls = [];
  const api = createClinicTenantApi({
    url: "https://project.supabase.co", publishableKey: "public-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 201, json: async () => [{ status: "requested" }] };
    }
  });
  await api.requestConnection("user-token", {
    accountId, locationId, channel: "facebook_messenger", status: "connected"
  });
  assert.equal(JSON.parse(calls[0].options.body).status, "requested");
  await assert.rejects(api.requestConnection("user-token", {
    accountId, locationId, channel: "unknown"
  }), { status: 400 });
});

test("onboarding rejects invalid names before calling the database", async () => {
  const api = createClinicTenantApi({
    url: "https://project.supabase.co", publishableKey: "public-key",
    fetchImpl: () => { throw new Error("unexpected network call"); }
  });
  await assert.rejects(api.onboard("user-token", "A", "First clinic"),
    { status: 400 });
});

test("staff follow-up uses the authenticated actor and a scoped outcome", async () => {
  const calls = [];
  const api = createClinicTenantApi({
    url: "https://project.supabase.co", publishableKey: "public-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 201, json: async () => [{ action: "handled" }] };
    }
  });
  const eventKey = "a".repeat(64);
  await api.appendFollowup("user-token", userId, {
    accountId, locationId, eventKey, action: "handled", actor_user_id: "other-user"
  });
  const row = JSON.parse(calls[0].options.body);
  assert.equal(row.actor_user_id, userId);
  assert.equal(row.account_id, accountId);
  assert.equal(row.location_id, locationId);
  assert.equal(row.event_key, eventKey);
  assert.equal(calls[0].options.headers.Authorization, "Bearer user-token");
  assert.match(api.scopedPath("clinic_followup_states", accountId, { locationId }),
    /location_id=eq\.e2395766/);
  await assert.rejects(api.appendFollowup("user-token", userId, {
    accountId, locationId, eventKey: "wrong", action: "handled"
  }), { status: 400 });
  assert.equal(calls.length, 1);
});

test("claim and booking actions require a location and use the staff actor", async () => {
  const writes = [];
  const api = createClinicTenantApi({
    url: "https://project.supabase.co", publishableKey: "public-key",
    fetchImpl: async (_url, options) => {
      writes.push(JSON.parse(options.body));
      return { ok: true, status: 201, json: async () => [] };
    }
  });
  const eventKey = "a".repeat(64);
  for (const action of ["claimed", "booked"]) {
    await api.appendFollowup("user-token", userId, { accountId, locationId, eventKey, action });
  }
  await assert.rejects(api.appendFollowup("user-token", userId, {
    accountId, eventKey, action: "claimed"
  }), { status: 400 });
  assert.deepEqual(writes.map(row => [row.action, row.actor_user_id]), [
    ["claimed", userId], ["booked", userId]
  ]);
});
