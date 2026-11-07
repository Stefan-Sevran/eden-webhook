const test = require("node:test");
const assert = require("node:assert/strict");
const { createMessengerConnect, messengerConnectPilot: pilot } = require("../clinic-messenger-connect");

function fixture() {
  let clock = Date.parse("2026-11-07T07:00:00Z");
  let role = "admin";
  let stored;
  const exchanges = [];
  const pageToken = "meta_page_credential_for_testing";
  const app = createMessengerConnect({
    appId: "980837197825196", appSecret: "test-secret", configId: "1234567", encryptionKey: "ab".repeat(32),
    now: () => clock,
    clinicTenantApi: { enabled: true, request: async () => [{ role }] },
    ledger: {
      enabled: true,
      async saveMessengerCredential(target, encrypted) {
        assert.equal(target, pilot);
        assert.ok(!encrypted.includes(pageToken));
        stored = encrypted;
        return "verifying";
      },
      messengerCredential: async () => stored
    },
    messenger: {
      async getPageToken(page, token) {
        assert.equal(page, pilot.pageId);
        assert.equal(token, "long_lived_user_token_for_testing");
        return pageToken;
      },
      async verifyPage(page, credentials, options) {
        assert.equal(page, pilot.pageId);
        assert.equal(credentials.pageToken, pageToken);
        assert.equal(options.subscribe, true);
        return true;
      }
    },
    async fetchImpl(url) {
      assert.equal(url.origin, "https://graph.facebook.com");
      exchanges.push(url);
      return Response.json({ access_token: exchanges.length === 1
        ? "short_lived_user_token_for_testing" : "long_lived_user_token_for_testing" });
    }
  });
  return { app, exchanges, pageToken, setRole: value => { role = value; }, expire: () => { clock += 600001; } };
}

const req = { clinicUserId: "test-admin", clinicToken: "session", body: {
  accountId: pilot.accountId, locationId: pilot.locationId
} };

test("connects Glow with a server-side code exchange and stores a scoped encrypted token", async () => {
  const { app, exchanges, pageToken } = fixture();
  const { url, state } = await app.start(req);
  const params = new URL(url).searchParams;
  assert.equal(params.get("config_id"), "1234567");
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("redirect_uri"), "https://clinicnet.live/clinic/");
  assert.equal(params.has("client_secret"), false);
  const result = await app.finish({ ...req, body: { ...req.body, state, code: "one-time-code" } });
  assert.deepEqual(result, { status: "verifying" });
  assert.equal(exchanges[0].searchParams.get("code"), "one-time-code");
  assert.equal(exchanges[1].searchParams.get("grant_type"), "fb_exchange_token");
  const route = { id: "test-route", account_id: pilot.accountId, location_id: pilot.locationId };
  assert.equal(await app.pageToken(pilot.pageId, route), pageToken);
  assert.equal(await app.pageToken(pilot.pageId, { ...route, location_id: "other" }), null);
});

test("rejects a foreign location, ordinary staff, and invalid or expired authorization before exchanging a code", async () => {
  const f = fixture();
  const { app, exchanges } = f;
  await assert.rejects(app.start({ ...req, body: { ...req.body, locationId: "other" } }), { status: 403 });
  f.setRole("staff");
  await assert.rejects(app.start(req), { status: 403 });
  f.setRole("owner");
  const { state } = await app.start(req);
  const callback = { ...req, body: { ...req.body, state, code: "test-code" } };
  await assert.rejects(app.finish({ ...callback, clinicUserId: "another-admin" }), { status: 400 });
  f.expire();
  await assert.rejects(app.finish(callback), { status: 400 });
  assert.equal(exchanges.length, 0);
});
