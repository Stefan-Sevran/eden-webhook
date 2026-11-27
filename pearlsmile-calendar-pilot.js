const { outcomeKey } = require("./outcome-ledger");
const { createHmac, randomUUID, timingSafeEqual } = require("node:crypto");

const SERVICE = "Initial consultation";
const TIME_ZONE = "Asia/Manila";
const SLOT_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MANILA_OFFSET = 8 * 60 * 60_000;

function pilotSlots(now) {
  const local = new Date(now + MANILA_OFFSET);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const slots = [];
  for (let day = 0; day < 7; day++) {
    const date = new Date(midnight + day * DAY_MS);
    if ([0, 6].includes(date.getUTCDay())) continue;
    for (let halfHour = 20; halfHour < 24; halfHour++) {
      const start = date.getTime() + halfHour * SLOT_MS - MANILA_OFFSET;
      if (start >= now + SLOT_MS) slots.push(new Date(start).toISOString());
    }
  }
  return slots;
}

function endOf(start) {
  return new Date(Date.parse(start) + SLOT_MS).toISOString();
}

function isBusy(start, intervals) {
  return intervals.some(interval => Date.parse(interval.start) < Date.parse(endOf(start)) &&
    Date.parse(interval.end) > Date.parse(start));
}

function bookingError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createPearlSmilePatientLinks({ secret, target, now = Date.now }) {
  const enabled = typeof secret === "string" && secret.length >= 32;
  const lifetime = 60 * 60_000;
  const sign = payload => createHmac("sha256", secret)
    .update(`pearlsmile-patient-v1:${target.accountId}:${target.locationId}:${payload}`)
    .digest();

  function create() {
    const payload = `${randomUUID()}.${now() + lifetime}`;
    return `${payload}.${sign(payload).toString("base64url")}`;
  }

  function read(token) {
    if (!enabled || typeof token !== "string") return null;
    const match = /^([a-f0-9-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return null;
    const [, requestId, expiry, signature] = match;
    if (Number(expiry) <= now() ||
        !timingSafeEqual(sign(`${requestId}.${expiry}`), Buffer.from(signature, "base64url"))) return null;
    return requestId;
  }

  return { enabled, create, read };
}

function createGooglePilotCalendar({ calendarId, clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  const enabled = [calendarId, clientId, clientSecret, refreshToken].every(Boolean);
  const path = "/calendars/" + encodeURIComponent(calendarId) + "/events";
  let token;
  let expiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < expiresAt) return token;
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
        refresh_token: refreshToken, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`Google Calendar token HTTP ${response.status}`);
    const data = await response.json();
    if (!data.access_token) throw new Error("Google Calendar token missing");
    token = data.access_token;
    expiresAt = Date.now() + Math.max(0, Number(data.expires_in) - 60) * 1000;
    return token;
  }

  async function request(route, body) {
    return fetchImpl("https://www.googleapis.com/calendar/v3" + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000)
    });
  }

  async function busy(timeMin, timeMax) {
    const response = await request("/freeBusy", { timeMin, timeMax, items: [{ id: calendarId }] });
    if (!response.ok) throw new Error(`Google Calendar availability HTTP ${response.status}`);
    const result = (await response.json()).calendars?.[calendarId];
    if (result?.errors?.length || !Array.isArray(result?.busy) ||
        result.busy.some(interval => !Number.isFinite(Date.parse(interval.start)) ||
          !Number.isFinite(Date.parse(interval.end)))) {
      throw new Error("Google Calendar did not return usable availability");
    }
    return result.busy;
  }

  async function read(id) {
    const response = await request(path + "/" + id);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Google Calendar read HTTP ${response.status}`);
    return response.json();
  }

  async function insert(id, requestId, startsAt, endsAt) {
    const response = await request(path + "?sendUpdates=none", {
      id, summary: "PearlSmile test · Initial consultation",
      start: { dateTime: startsAt, timeZone: TIME_ZONE },
      end: { dateTime: endsAt, timeZone: TIME_ZONE },
      extendedProperties: { private: { edenPilotRequest: requestId } }
    });
    if (response.status === 409) return read(id);
    if (!response.ok) throw new Error(`Google Calendar write HTTP ${response.status}`);
    return response.json();
  }

  return { enabled, busy, read, insert };
}

function createPearlSmileCalendarPilot({ calendar, ledger, target, now = Date.now }) {
  const enabled = Boolean(calendar.enabled && ledger.enabled);

  async function availability(date) {
    if (date !== undefined && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      throw bookingError(400, "Choose a valid consultation date.");
    }
    const slots = pilotSlots(now()).filter(start => !date ||
      new Date(Date.parse(start) + MANILA_OFFSET).toISOString().startsWith(date));
    if (!slots.length) return { service: SERVICE, timeZone: TIME_ZONE, slots: [] };
    const [busy, reserved] = await Promise.all([
      calendar.busy(slots[0], endOf(slots.at(-1))),
      ledger.calendarPilotReservedSlots(target.locationId, slots[0], slots.at(-1))
    ]);
    const claimed = new Set(reserved);
    return { service: SERVICE, timeZone: TIME_ZONE,
      slots: slots.filter(slot => !claimed.has(slot) && !isBusy(slot, busy)).slice(0, 6) };
  }

  async function book(start, requestId, channel = "website_chat") {
    const timestamp = Date.parse(start);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== start) {
      throw bookingError(409, "Choose a fresh consultation time.");
    }
    const bookable = pilotSlots(now()).includes(start);
    const end = endOf(start);
    const id = outcomeKey("pearlsmile-calendar-v1", target.locationId, start);

    // Preserve the same claim and event identity through retries, including an
    // ambiguous Calendar response or a failure writing to the activity ledger.
    const existing = await ledger.calendarPilotClaim(target.locationId, start);
    if (!existing && !bookable) throw bookingError(409, "Choose a fresh consultation time.");
    if (!existing && isBusy(start, await calendar.busy(start, end))) {
      throw bookingError(409, "That time is taken. Choose another slot.");
    }
    const claimed = !existing && await ledger.claimCalendarPilotSlot(target.locationId, start, requestId);
    const owner = claimed ? requestId : existing || await ledger.calendarPilotClaim(target.locationId, start);
    if (owner !== requestId) throw bookingError(409, "That time is taken. Choose another slot.");

    let event = await calendar.read(id);
    if (!event) {
      if (!bookable) throw bookingError(409, "Choose a fresh consultation time.");
      if (!claimed && !await ledger.renewCalendarPilotAttempt(target.locationId, start, requestId)) {
        throw bookingError(503, "Still checking that reservation. Try the same time again shortly.");
      }
      if (isBusy(start, await calendar.busy(start, end))) {
        // Another attempt with this same request may have just completed.
        event = await calendar.read(id);
        if (!event) throw bookingError(409, "That time is taken. Choose another slot.");
      } else {
        if (!pilotSlots(now()).includes(start)) throw bookingError(409, "Choose a fresh consultation time.");
        event = await calendar.insert(id, requestId, start, end);
      }
    }
    if (event?.id !== id || event.status !== "confirmed" ||
        event.extendedProperties?.private?.edenPilotRequest !== requestId ||
        Date.parse(event.start?.dateTime) !== Date.parse(start) ||
        Date.parse(event.end?.dateTime) !== Date.parse(end)) {
      throw new Error("Google Calendar did not acknowledge the expected booking");
    }

    await ledger.record({
      event_key: id, account_id: target.accountId, location_id: target.locationId, clinic_id: target.locationId,
      channel, kind: "booking.updated", status: "CONFIRMED",
      summary: "PearlSmile Cebu test · Initial consultation",
      details: { bookingId: id, demo: true, service: SERVICE,
        appointmentAt: start, appointmentEndsAt: end, calendarEventId: id }
    });
    return { status: "CONFIRMED", service: SERVICE, start, end, timeZone: TIME_ZONE,
      accountId: target.accountId, locationId: target.locationId };
  }

  return { enabled, availability, book };
}

module.exports = { createGooglePilotCalendar, createPearlSmileCalendarPilot, createPearlSmilePatientLinks };
