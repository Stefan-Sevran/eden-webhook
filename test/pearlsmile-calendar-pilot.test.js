const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createGooglePilotCalendar, createPearlSmileCalendarPilot, createPearlSmilePatientLinks } =
  require("../pearlsmile-calendar-pilot");

function fixture() {
  const claims = new Map();
  const events = new Map();
  const outcomes = new Map();
  const staffBookings = [];
  let writes = 0;
  let failLedger = false;
  const calendar = {
    enabled: true,
    busy: async () => [...staffBookings, ...Array.from(events.values(),
      event => ({ start: event.start.dateTime, end: event.end.dateTime }))],
    read: async id => events.get(id),
    insert: async (id, requestId, start, end) => {
      writes++;
      const event = { id, status: "confirmed", start: { dateTime: start }, end: { dateTime: end },
        extendedProperties: { private: { edenPilotRequest: requestId } } };
      events.set(id, event);
      return event;
    }
  };
  const ledger = {
    enabled: true,
    calendarPilotReservedSlots: async () => Array.from(claims.keys()),
    calendarPilotClaim: async (_, start) => claims.get(start),
    claimCalendarPilotSlot: async (_, start, requestId) => {
      if (claims.has(start) || Array.from(claims.values()).includes(requestId)) return false;
      claims.set(start, requestId);
      return true;
    },
    renewCalendarPilotAttempt: async () => false,
    record: async event => {
      if (failLedger) {
        failLedger = false;
        throw Error("Ledger unavailable");
      }
      outcomes.set(event.event_key, event);
    }
  };
  const pilot = createPearlSmileCalendarPilot({ calendar, ledger,
    target: { accountId: "test-account", locationId: "test-location" },
    now: () => Date.parse("2026-11-26T01:00:00Z") });
  return { calendar, pilot, events, outcomes, staffBookings, writes: () => writes,
    failNextLedger: () => { failLedger = true; } };
}

test("staff calendar events are excluded and a stale selection never confirms", async () => {
  const { pilot, staffBookings, outcomes, writes } = fixture();
  const { slots } = await pilot.availability();
  assert.equal(slots[0], "2026-11-26T02:00:00.000Z");
  staffBookings.push({ start: slots[0], end: "2026-11-26T02:30:00.000Z" });
  await assert.rejects(pilot.book(slots[0], "first"), { status: 409 });
  assert.equal(writes(), 0);
  assert.equal(outcomes.size, 0);
  assert.ok(!(await pilot.availability()).slots.includes(slots[0]));
});

test("separate patients competing for a slot can only confirm one booking", async () => {
  const { pilot, outcomes, writes } = fixture();
  const { slots: [start] } = await pilot.availability();
  const results = await Promise.allSettled([pilot.book(start, "first"), pilot.book(start, "second")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
  assert.equal(writes(), 1);
  assert.equal(outcomes.size, 1);
  assert.equal(Array.from(outcomes.values())[0].details.appointmentAt, start);
});

test("availability can return a later Cebu date without mixing in earlier slots", async () => {
  const { pilot } = fixture();
  assert.ok(!(await pilot.availability()).slots.some(start => start.startsWith("2026-11-30")));
  const { slots } = await pilot.availability("2026-11-30");
  assert.equal(slots.length, 4);
  assert.ok(slots.every(start => start.startsWith("2026-11-30")));
  assert.deepEqual((await pilot.availability("2026-11-28")).slots, []);
  await assert.rejects(pilot.availability(["2026-11-30"]), { status: 400 });
});

test("a patient link expires and cannot be forged or accepted for a different location", () => {
  let time = Date.parse("2026-11-26T01:00:00Z");
  const options = { secret: "fixture patient signing key with 32 bytes", now: () => time,
    target: { accountId: "test-account", locationId: "test-location" } };
  const links = createPearlSmilePatientLinks(options);
  const token = links.create();
  assert.match(links.read(token), /^[a-f0-9-]{36}$/);
  assert.equal(links.read((token.startsWith("a") ? "b" : "a") + token.slice(1)), null);
  assert.equal(createPearlSmilePatientLinks({ ...options,
    target: { ...options.target, locationId: "other-location" } }).read(token), null);
  assert.equal(createPearlSmilePatientLinks({ ...options, secret: undefined }).read(token), null);
  time += 60 * 60_000;
  assert.equal(links.read(token), null);
});

test("one patient link can reserve only one slot and retry the confirmed reservation", async () => {
  const { pilot, outcomes, writes } = fixture();
  const links = createPearlSmilePatientLinks({ secret: "fixture patient signing key with 32 bytes",
    target: { accountId: "test-account", locationId: "test-location" } });
  const requestId = links.read(links.create());
  const { slots } = await pilot.availability();
  const attempts = await Promise.allSettled(slots.slice(0, 2).map(start => pilot.book(start, requestId)));
  const winner = attempts.find(attempt => attempt.status === "fulfilled").value;
  assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.find(attempt => attempt.status === "rejected").reason.status, 409);
  assert.deepEqual(await pilot.book(winner.start, requestId), winner);
  assert.equal(writes(), 1);
  assert.equal(outcomes.size, 1);
});

test("retries recover a calendar booking if Daily Action was briefly unavailable", async () => {
  const { pilot, failNextLedger, outcomes, writes } = fixture();
  const { slots: [start] } = await pilot.availability();
  failNextLedger();
  await assert.rejects(pilot.book(start, "same"), /Ledger unavailable/);
  assert.equal(outcomes.size, 0);
  const recovered = await pilot.book(start, "same");
  assert.equal(recovered.status, "CONFIRMED");
  assert.deepEqual(await pilot.book(start, "same"), recovered);
  assert.equal(writes(), 1);
  assert.equal(outcomes.size, 1);
});

test("calendar write failure produces no confirmed Daily Action outcome", async () => {
  const { pilot, calendar, outcomes } = fixture();
  const { slots: [start] } = await pilot.availability();
  calendar.insert = async () => { throw Error("Calendar unavailable"); };
  await assert.rejects(pilot.book(start, "same"), /Calendar unavailable/);
  assert.equal(outcomes.size, 0);
  assert.ok(!(await pilot.availability()).slots.includes(start));
});

test("Google adapter checks the named calendar and writes an event without inviting attendees", async () => {
  const requests = [];
  const calendar = createGooglePilotCalendar({
    calendarId: "test@calendar.example", clientId: "id", clientSecret: "secret", refreshToken: "token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("/token")) return Response.json({ access_token: "test-access", expires_in: 3600 });
      if (url.endsWith("/freeBusy")) return Response.json({ calendars: { "test@calendar.example": { busy: [] } } });
      return Response.json({ id: "abcdef" });
    }
  });
  const start = "2026-11-26T02:00:00.000Z";
  const end = "2026-11-26T02:30:00.000Z";
  assert.deepEqual(await calendar.busy(start, end), []);
  await calendar.insert("abcdef", "request-id", start, end);
  assert.equal(requests.length, 3);
  const write = requests[2];
  assert.match(write.url, /test%40calendar.example\/events\?sendUpdates=none$/);
  const event = JSON.parse(write.options.body);
  assert.equal(event.attendees, undefined);
  assert.equal(event.extendedProperties.private.edenPilotRequest, "request-id");
});
