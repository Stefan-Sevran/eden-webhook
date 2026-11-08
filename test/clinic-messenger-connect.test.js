const test = require("node:test");
const assert = require("node:assert/strict");
const { createMessengerConnect, parseMessengerPilots, messengerConnectPilot: pilot } = require("../clinic-messenger-connect");

function fixture(target = pilot, pilots, guidedMessengerSetup = false) {
  let clock = Date.parse("2026-11-07T07:00:00Z");
  let role = "admin";
  let stored;
  let facts;
  const exchanges = [];
  const pageToken = "meta_page_credential_for_testing";
  const app = createMessengerConnect({
    appId: "980837197825196", appSecret: "test-secret", configId: "1234567", encryptionKey: "ab".repeat(32),
    now: () => clock, pilots, guidedMessengerSetup,
    clinicTenantApi: { enabled: true, request: async (_, path) => path.startsWith("clinic_locations?")
      ? [{ id: target.locationId, messenger_facts: facts }] : [{ role }] },
    ledger: {
      enabled: true,
      async saveMessengerFacts(savedTarget, value) {
        assert.equal(savedTarget.locationId, target.locationId);
        facts = value;
        return facts;
      },
      async messengerLocation() { return { location: { messenger_facts: facts } }; },
      async saveMessengerCredential(savedTarget, encrypted) {
        assert.equal(savedTarget.locationId, target.locationId);
        assert.ok(!encrypted.includes(pageToken));
        stored = encrypted;
        return "verifying";
      },
      messengerCredential: async () => stored
    },
    messenger: {
      async getPageToken(page, token) {
        assert.equal(page, target.pageId);
        assert.equal(token, "long_lived_user_token_for_testing");
        return pageToken;
      },
      async verifyPage(page, credentials, options) {
        assert.equal(page, target.pageId);
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

test("only pilot administrators can confirm facts and issue a Page-bound setup test", async () => {
  const { app, setRole } = fixture(pilot, undefined, true);
  const facts = { services: " Cleanings ", hours: "Weekdays", address: "Main Street", bookingRules: "Staff confirm times" };
  const save = { ...req, body: { ...req.body, facts } };
  await assert.rejects(app.startTest(req), { status: 409 });
  await assert.rejects(app.saveFacts({ ...save, body: { ...save.body, facts: { ...facts, hours: " " } } }), { status: 400 });
  setRole("staff");
  await assert.rejects(app.saveFacts(save), { status: 403 });
  await assert.rejects(app.startTest(req), { status: 403 });
  setRole("admin");
  const expected = { ...facts, services: "Cleanings" };
  assert.deepEqual(await app.saveFacts(save), { facts: expected });
  assert.deepEqual((await app.setups({ ...req, query: { accountId: pilot.accountId } }))[0].facts, expected);
  const { message, testId, expiresAt } = await app.startTest(req);
  assert.equal(app.readSetupTest(message, pilot.pageId, pilot, expiresAt - 1000), testId);
  assert.equal(app.readSetupTest(message, pilot.pageId, pilot, expiresAt + 1), null);
  assert.equal(app.readSetupTest(message, "1234567890", pilot, expiresAt - 1000), null);
  assert.equal(app.readSetupTest(message.replace(/.$/, message.endsWith("A") ? "Q" : "A"), pilot.pageId, pilot, expiresAt - 1000), null);
  await assert.rejects(fixture().app.saveFacts(save), { status: 503 });
});

test("the second workspace gets its own Page, and an OAuth return cannot switch clinics", async () => {
  const second = {
    accountId: "4aed5565-40a1-4b31-8d86-0c6c28f108d4",
    locationId: "296b09f3-5828-48df-9809-3263ac3f6de3",
    pageId: "1234567890", clinicName: "Second test Page", facts: "Staff confirm appointments."
  };
  const pilots = parseMessengerPilots(JSON.stringify([second]), ["1086617101195136"]);
  assert.throws(() => parseMessengerPilots(JSON.stringify([{ ...second, pageId: pilot.pageId }]), []), /duplicate/);
  const { app, exchanges, pageToken, setRole } = fixture(second, pilots);
  const secondReq = { ...req, body: { accountId: second.accountId, locationId: second.locationId } };
  assert.deepEqual((await app.setups({ ...req, query: { accountId: second.accountId } })).map(row => row.locationId),
    [second.locationId]);
  setRole("staff");
  assert.deepEqual(await app.setups({ ...req, query: { accountId: second.accountId } }), []);
  setRole("admin");
  const { state } = await app.start(secondReq);
  await assert.rejects(app.finish({ ...req, body: { ...req.body, state, code: "test-code" } }), { status: 400 });
  assert.equal(exchanges.length, 0);
  await app.finish({ ...secondReq, body: { ...secondReq.body, state, code: "test-code" } });
  const route = { id: "second-route", account_id: second.accountId, location_id: second.locationId };
  assert.equal(await app.pageToken(second.pageId, route), pageToken);
  assert.equal(await app.pageToken(pilot.pageId, route), null);
  await assert.rejects(app.pageToken(pilot.pageId, { ...route, account_id: pilot.accountId, location_id: pilot.locationId }),
    /authenticate/i);
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
