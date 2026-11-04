const twilio = require("twilio");
const { E164 } = require("./voice-routing");

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INBOUND = "/voice/inbound";
const STAFF_RESULT = "/voice/staff-result";
const AI_RESULT = "/voice/ai-result";
const MISSED = new Set(["busy", "no-answer", "failed"]);

function minutes(clock) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw Error("Invalid clinic hour");
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

function parseHours(hours) {
  if (hours === undefined) return null;
  if (!hours || typeof hours !== "object" || Array.isArray(hours)) throw Error("Invalid clinic hours");
  const result = {};
  for (const [day, periods] of Object.entries(hours)) {
    if (!DAYS.includes(day) || !Array.isArray(periods)) throw Error("Invalid clinic day");
    result[day] = periods.map(period => {
      if (!Array.isArray(period) || period.length !== 2) throw Error("Invalid clinic period");
      const [start, end] = period.map(minutes);
      if (start === end) throw Error("Clinic period must have a start and end");
      return { start, end };
    });
  }
  return result;
}

function readRoutes(raw) {
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows) || !rows.length) throw Error("Voice routes must be a nonempty list");
  const incoming = new Set();
  const routes = new Map();
  for (const row of rows) {
    if (!row || !E164.test(row.ingressNumber || "") || !E164.test(row.clinicNumber || "") ||
        routes.has(row.ingressNumber)) throw Error("Invalid or duplicate ingress");
    incoming.add(row.ingressNumber);
    incoming.add(row.clinicNumber);
    routes.set(row.ingressNumber, row);
  }
  const aiDestinations = new Set();
  for (const [number, row] of routes) {
    const { mode, staffNumber, aiNumber, fallbackNumber, timeZone, override } = row;
    if (!["conditional_forwarding", "managed"].includes(mode) ||
        [aiNumber, fallbackNumber, ...(mode === "managed" ? [staffNumber] : [])]
          .some(target => typeof target !== "string" || !E164.test(target) || incoming.has(target)) ||
        aiDestinations.has(aiNumber) || aiNumber === fallbackNumber || (mode === "managed" && aiNumber === staffNumber)) {
      throw Error("Invalid voice mode or unsafe dial destination");
    }
    aiDestinations.add(aiNumber);
    const ringSeconds = row.ringSeconds ?? 25;
    if (!Number.isInteger(ringSeconds) || ringSeconds < 10 || ringSeconds > 60) {
      throw Error("Invalid staff ring time");
    }
    if (mode === "managed" && typeof timeZone !== "string") throw Error("Managed routing requires a timezone");
    const clock = mode === "managed" ? new Intl.DateTimeFormat("en-GB", {
      timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }) : null;
    const hours = parseHours(row.hours);
    let until = null;
    if (override !== undefined) {
      if (!override || !["paused", "cover_now"].includes(override.mode) ||
          (override.mode === "cover_now" && !override.until)) throw Error("Invalid voice override");
      if (override.until !== undefined) {
        if (typeof override.until !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(override.until)) {
          throw Error("Voice override expiry requires a timezone offset");
        }
        until = Date.parse(override.until);
        if (!Number.isFinite(until)) throw Error("Invalid voice override expiry");
      }
    }
    routes.set(number, { mode, staffNumber, aiNumber, fallbackNumber, ringSeconds, clock, hours,
      override: override?.mode, until });
  }
  return routes;
}

function isOpen(route, now) {
  if (!route.hours) return true;
  const parts = Object.fromEntries(route.clock.formatToParts(now).map(({ type, value }) => [type, value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const previous = DAYS[(DAYS.indexOf(parts.weekday) + 6) % 7];
  return (route.hours[parts.weekday] || []).some(({ start, end }) =>
    minute >= start && (end < start || minute < end)) ||
    (route.hours[previous] || []).some(({ start, end }) => end < start && minute < end);
}

function destination(route, now) {
  if (route.until === null || now.getTime() < route.until) {
    if (route.override === "paused") return "fallback";
    if (route.override === "cover_now") return "ai";
  }
  return route.mode === "managed" && isOpen(route, now) ? "staff" : "ai";
}

function createVoiceIngress({ rawRoutes, publicUrl, authToken, accountSid, now = () => new Date() }) {
  const origin = new URL(publicUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash || !authToken ||
      !/^AC[0-9a-f]{32}$/i.test(accountSid || "")) throw Error("Invalid Twilio voice webhook configuration");
  const routes = readRoutes(rawRoutes);

  return (req, res) => {
    if (req.originalUrl !== req.path || !req.is("application/x-www-form-urlencoded") ||
        !twilio.validateRequest(authToken, req.get("X-Twilio-Signature") || "",
          origin.origin + req.originalUrl, req.body) ||
        req.body.AccountSid !== accountSid) return res.sendStatus(403);
    const route = routes.get(req.body.To);
    if (!route || !/^CA[0-9a-f]{32}$/i.test(req.body.CallSid || "")) return res.sendStatus(404);

    const response = new twilio.twiml.VoiceResponse();
    let next = null;
    if (req.path === INBOUND) next = destination(route, now());
    if (req.path === STAFF_RESULT && MISSED.has(req.body.DialCallStatus)) next = "ai";
    if (req.path === AI_RESULT && MISSED.has(req.body.DialCallStatus)) next = "fallback";

    if (next === "staff") {
      response.dial({ answerOnBridge: true, timeout: route.ringSeconds, method: "POST",
        action: origin.origin + STAFF_RESULT }, route.staffNumber);
    } else if (next === "ai") {
      response.dial({ answerOnBridge: true, timeout: 20, method: "POST",
        action: origin.origin + AI_RESULT }, route.aiNumber);
    } else if (next === "fallback") {
      response.dial({ answerOnBridge: true, timeout: 25 }, route.fallbackNumber);
    } else {
      response.hangup();
    }
    return res.type("text/xml").send(response.toString());
  };
}

module.exports = { createVoiceIngress };
