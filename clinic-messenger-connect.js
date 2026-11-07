const { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { isUuid } = require("./clinic-tenant");
const { pageNumber } = require("./clinic-messenger");

const pilot = Object.freeze({
  accountId: "76d85891-181d-4b99-a427-dd4dbc680e8a",
  locationId: "b865c71a-e9f1-4b09-acb5-0b5043ab4307",
  pageId: "1020927517779945",
  clinicName: "Glow Aesthetics Manila",
  pageUrl: "https://www.facebook.com/profile.php?id=61590069232706",
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

function parseMessengerPilots(raw, reservedPageIds) {
  const additional = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(additional)) throw Error("Expected a list of Messenger pilot locations");
  const pages = new Set(reservedPageIds);
  const locations = new Map();
  for (const candidate of [pilot, ...additional]) {
    if (!candidate || !isUuid(candidate.accountId) || !isUuid(candidate.locationId) ||
        typeof candidate.pageId !== "string" || !pageNumber.test(candidate.pageId) ||
        typeof candidate.clinicName !== "string" || !candidate.clinicName.trim() || candidate.clinicName.length > 120 ||
        typeof candidate.facts !== "string" || !candidate.facts.trim() || candidate.facts.length > 6000 ||
        pages.has(candidate.pageId) || locations.has(candidate.locationId)) {
      throw Error("Invalid or duplicate Messenger pilot location");
    }
    const { accountId, locationId, pageId, clinicName, facts } = candidate;
    const pageUrl = candidate.pageUrl ? new URL(candidate.pageUrl) : null;
    if (pageUrl && (pageUrl.origin !== "https://www.facebook.com" || pageUrl.username || pageUrl.password)) {
      throw Error("Expected a public Facebook Page URL");
    }
    pages.add(candidate.pageId);
    locations.set(locationId, { accountId, locationId, pageId, clinicName, facts, pageUrl: pageUrl?.href });
  }
  return locations;
}

function createMessengerConnect({ appId, appSecret, configId, encryptionKey, ledger,
  clinicTenantApi, messenger, pilots = new Map([[pilot.locationId, pilot]]), fetchImpl = fetch, now = Date.now }) {
  const enabled = Boolean(/^\d{5,30}$/.test(appId || "") && appSecret &&
    /^\d{5,30}$/.test(configId || "") && /^[a-f0-9]{64}$/i.test(encryptionKey || "") &&
    ledger.enabled && clinicTenantApi.enabled);
  const key = enabled ? Buffer.from(encryptionKey, "hex") : null;

  async function isAdmin(req, accountId) {
    const filter = new URLSearchParams({
      select: "role", user_id: "eq." + req.clinicUserId, account_id: "eq." + accountId
    });
    const [membership] = await clinicTenantApi.request(req.clinicToken, "clinic_memberships?" + filter);
    return ["owner", "admin"].includes(membership?.role);
  }

  async function setups(req) {
    const accountId = req.query.accountId;
    if (!isUuid(accountId)) throw connectionError(400, "Invalid clinic account");
    const targets = [...pilots.values()].filter(target => target.accountId === accountId);
    if (!enabled || !targets.length || !await isAdmin(req, accountId)) return [];
    return targets.map(({ locationId, clinicName, pageUrl }) => ({ locationId, clinicName, pageUrl }));
  }

  async function requirePilotAdmin(req) {
    if (!enabled) throw connectionError(503, "Messenger browser connection is unavailable");
    const target = pilots.get(req.body?.locationId);
    if (!target || req.body?.accountId !== target.accountId) {
      throw connectionError(403, "Messenger is unavailable for this location");
    }
    if (!await isAdmin(req, target.accountId)) {
      throw connectionError(403, "Messenger connection requires a clinic admin");
    }
    return target;
  }

  function signature(value, userId, locationId) {
    return createHmac("sha256", key).update(JSON.stringify(["messenger-state", value, userId, locationId]))
      .digest("base64url");
  }

  async function start(req) {
    const target = await requirePilotAdmin(req);
    const value = [statePrefix, now() + stateDuration, randomBytes(18).toString("base64url")].join(".");
    const state = value + "." + signature(value, req.clinicUserId, target.locationId);
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

  function encrypt(token, target) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(target.locationId + ":" + target.pageId));
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
  }

  async function finish(req) {
    const target = await requirePilotAdmin(req);
    const { state, code } = req.body;
    const match = typeof state === "string" &&
      /^(eden-messenger\.\d{13}\.[a-zA-Z0-9_-]{24})\.([a-zA-Z0-9_-]{43})$/.exec(state);
    const expires = match ? Number(match[1].split(".")[1]) : 0;
    if (!match || expires <= now() || expires > now() + stateDuration ||
        !timingSafeEqual(Buffer.from(match[2]), Buffer.from(signature(match[1], req.clinicUserId, target.locationId))) ||
        typeof code !== "string" || !code || code.length > 8192) {
      throw connectionError(400, "Messenger authorization expired or is invalid");
    }
    const userToken = await exchange({ code, redirect_uri: redirectUri });
    const longLived = await exchange({ grant_type: "fb_exchange_token", fb_exchange_token: userToken });
    const pageToken = await messenger.getPageToken(target.pageId, longLived).catch(() => null);
    if (!tokenFormat.test(pageToken || "")) {
      throw connectionError(422, "Meta did not grant access to the selected location's Page");
    }
    const verified = await messenger.verifyPage(target.pageId, { pageToken }, { subscribe: true })
      .catch(error => {
        // verifyPage reports only fixed labels and numeric provider codes.
        throw connectionError(422, error.message);
      });
    if (!verified) throw connectionError(422, "Meta did not confirm the Page's messages webhook");
    const status = await ledger.saveMessengerCredential(target, encrypt(pageToken, target));
    if (!["verifying", "connected"].includes(status)) {
      throw connectionError(409, "This location already has a different Messenger Page");
    }
    return { status };
  }

  async function pageToken(pageId, route) {
    const target = pilots.get(route.location_id);
    if (!enabled || !target || pageId !== target.pageId || route.account_id !== target.accountId) return null;
    const stored = await ledger.messengerCredential(route.id);
    if (!stored) return null;
    const [iv, tag, encrypted] = stored.split(".").map(part => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(target.locationId + ":" + target.pageId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  return { enabled, setups, start, finish, pageToken, isAdmin };
}

module.exports = { createMessengerConnect, parseMessengerPilots, messengerConnectPilot: pilot };
