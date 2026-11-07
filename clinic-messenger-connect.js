const { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const pilot = Object.freeze({
  accountId: "76d85891-181d-4b99-a427-dd4dbc680e8a",
  locationId: "b865c71a-e9f1-4b09-acb5-0b5043ab4307",
  pageId: "1020927517779945",
  clinicName: "Glow Aesthetics Manila",
  facts: "This is a test clinic in Manila. Use fictional facial consultation requests for the pilot. Staff confirm prices, hours, and appointment availability."
});
const redirectUri = "https://clinicnet.live/clinic/";
const statePrefix = "eden-messenger";
const stateDuration = 10 * 60 * 1000;
const graphBase = "https://graph.facebook.com/v25.0/";
const tokenFormat = /^[a-zA-Z0-9_-]{20,4096}$/;

function connectionError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createMessengerConnect({ appId, appSecret, configId, encryptionKey, ledger,
  clinicTenantApi, messenger, fetchImpl = fetch, now = Date.now }) {
  const enabled = Boolean(/^\d{5,30}$/.test(appId || "") && appSecret &&
    /^\d{5,30}$/.test(configId || "") && /^[a-f0-9]{64}$/i.test(encryptionKey || "") &&
    ledger.enabled && clinicTenantApi.enabled);
  const key = enabled ? Buffer.from(encryptionKey, "hex") : null;

  async function requirePilotAdmin(req) {
    if (!enabled) throw connectionError(503, "Messenger browser connection is unavailable");
    if (req.body?.accountId !== pilot.accountId || req.body?.locationId !== pilot.locationId) {
      throw connectionError(403, "Messenger browser connection is limited to Test Location");
    }
    const filter = new URLSearchParams({
      select: "role", user_id: "eq." + req.clinicUserId, account_id: "eq." + pilot.accountId
    });
    const [membership] = await clinicTenantApi.request(req.clinicToken, "clinic_memberships?" + filter);
    if (!["owner", "admin"].includes(membership?.role)) {
      throw connectionError(403, "Messenger connection requires a clinic admin");
    }
  }

  function signature(value, userId) {
    return createHmac("sha256", key).update(JSON.stringify(["messenger-state", value, userId, pilot.locationId]))
      .digest("base64url");
  }

  async function start(req) {
    await requirePilotAdmin(req);
    const value = [statePrefix, now() + stateDuration, randomBytes(18).toString("base64url")].join(".");
    const state = value + "." + signature(value, req.clinicUserId);
    const url = new URL("https://www.facebook.com/v25.0/dialog/oauth");
    url.search = new URLSearchParams({
      client_id: appId, config_id: configId, redirect_uri: redirectUri, response_type: "code",
      state, auth_type: "rerequest"
    });
    return { url: url.toString(), state };
  }

  async function exchange(fields) {
    const url = new URL("oauth/access_token", graphBase);
    url.search = new URLSearchParams({ client_id: appId, client_secret: appSecret, ...fields });
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => null);
    if (!response.ok || !tokenFormat.test(data?.access_token || "")) {
      throw connectionError(422, "Meta did not issue a usable user token");
    }
    return data.access_token;
  }

  function encrypt(token) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(pilot.locationId + ":" + pilot.pageId));
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
  }

  async function finish(req) {
    await requirePilotAdmin(req);
    const { state, code } = req.body;
    const match = typeof state === "string" &&
      /^(eden-messenger\.\d{13}\.[a-zA-Z0-9_-]{24})\.([a-zA-Z0-9_-]{43})$/.exec(state);
    const expires = match ? Number(match[1].split(".")[1]) : 0;
    if (!match || expires <= now() || expires > now() + stateDuration ||
        !timingSafeEqual(Buffer.from(match[2]), Buffer.from(signature(match[1], req.clinicUserId))) ||
        typeof code !== "string" || !code || code.length > 8192) {
      throw connectionError(400, "Messenger authorization expired or is invalid");
    }
    const userToken = await exchange({ code, redirect_uri: redirectUri });
    const longLived = await exchange({ grant_type: "fb_exchange_token", fb_exchange_token: userToken });
    const pageToken = await messenger.getPageToken(pilot.pageId, longLived).catch(() => null);
    if (!tokenFormat.test(pageToken || "")) {
      throw connectionError(422, "Meta did not grant access to Glow Aesthetics Manila");
    }
    const verified = await messenger.verifyPage(pilot.pageId, { pageToken }, { subscribe: true })
      .catch(error => {
        // verifyPage reports only fixed labels and numeric provider codes.
        throw connectionError(422, error.message);
      });
    if (!verified) throw connectionError(422, "Meta did not confirm Glow's messages webhook");
    const status = await ledger.saveMessengerCredential(pilot, encrypt(pageToken));
    if (!["verifying", "connected"].includes(status)) {
      throw connectionError(409, "This location already has a different Messenger Page");
    }
    return { status };
  }

  async function pageToken(pageId, route) {
    if (!enabled || pageId !== pilot.pageId ||
        route.account_id !== pilot.accountId || route.location_id !== pilot.locationId) return null;
    const stored = await ledger.messengerCredential(route.id);
    if (!stored) return null;
    const [iv, tag, encrypted] = stored.split(".").map(part => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(pilot.locationId + ":" + pilot.pageId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  return { enabled, start, finish, pageToken };
}

module.exports = { createMessengerConnect, messengerConnectPilot: pilot };
