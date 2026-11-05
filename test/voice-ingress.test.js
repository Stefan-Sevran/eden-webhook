const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
const twilio = require("twilio");
const { createVoiceIngress } = require("../voice-ingress");

const origin = "https://routing.example";
const authToken = "fixture-only-auth-token";
const accountSid = "AC" + "a".repeat(32);
const route = {
  mode: "managed", ingressNumber: "+12025550101", clinicNumber: "+12025550102",
  staffNumber: "+12025550103", aiNumber: "+12025550104", fallbackNumber: "+12025550105",
  ringSeconds: 28, timeZone: "Asia/Bangkok", hours: { Wed: [["09:00", "17:00"]] }
};
const form = { AccountSid: accountSid, CallSid: "CA" + "b".repeat(32),
  To: route.ingressNumber, From: "+12025550106", ForwardedFrom: route.clinicNumber };

async function setup(t, options = route) {
  let clock = new Date("2026-11-04T03:00:00Z");
  const app = express();
  const handler = createVoiceIngress({ rawRoutes: JSON.stringify([options]), publicUrl: origin,
    authToken, accountSid, now: () => clock });
  app.post(["/voice/inbound", "/voice/staff-result", "/voice/ai-result"],
    express.urlencoded({ extended: false }), handler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  return {
    setTime(value) { clock = new Date(value); },
    async send(path = "/voice/inbound", body = form, token = authToken) {
      const response = await fetch("http://127.0.0.1:" + server.address().port + path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilio.getExpectedTwilioSignature(token, origin + path, body) },
        body: new URLSearchParams(body)
      });
      return { status: response.status, xml: await response.text() };
    }
  };
}

test("signed managed calls ring staff first during open hours and AI after closing", async t => {
  const api = await setup(t);
  const open = await api.send();
  assert.equal(open.status, 200);
  assert.ok(open.xml.includes(route.staffNumber));
  assert.match(open.xml, /timeout="28"/);
  assert.match(open.xml, /\/voice\/staff-result/);
  api.setTime("2026-11-04T10:00:00Z");
  const closed = await api.send();
  assert.ok(closed.xml.includes(route.aiNumber));
  assert.ok(!closed.xml.includes(route.staffNumber));
});

test("busy or unanswered staff calls go to AI and failed AI legs go to fallback", async t => {
  const api = await setup(t);
  for (const state of ["busy", "no-answer", "failed"]) {
    const ai = await api.send("/voice/staff-result", { ...form, DialCallStatus: state });
    assert.ok(ai.xml.includes(route.aiNumber));
    const backup = await api.send("/voice/ai-result", { ...form, DialCallStatus: state });
    assert.ok(backup.xml.includes(route.fallbackNumber));
  }
  for (const state of ["completed", "answered", "canceled"]) {
    const done = await api.send("/voice/staff-result", { ...form, DialCallStatus: state });
    assert.match(done.xml, /<Hangup\/>/);
    const aiDone = await api.send("/voice/ai-result", { ...form, DialCallStatus: state });
    assert.match(aiDone.xml, /<Hangup\/>/);
  }
});

test("conditional forwarding goes straight to AI, including during business hours", async t => {
  const api = await setup(t, { ...route, mode: "conditional_forwarding" });
  const forwarded = await api.send();
  assert.ok(forwarded.xml.includes(route.aiNumber));
  assert.ok(!forwarded.xml.includes(route.staffNumber));
});

test("a two-number route speaks the fallback message when the AI leg fails", async t => {
  const fallbackMessage = "Our receptionist is unavailable. Please try again shortly.";
  const api = await setup(t, { ...route, mode: "conditional_forwarding", clinicNumber: route.ingressNumber,
    fallbackNumber: undefined, fallbackMessage });
  assert.ok((await api.send()).xml.includes(route.aiNumber));
  for (const state of ["busy", "no-answer", "failed"]) {
    const backup = await api.send("/voice/ai-result", { ...form, DialCallStatus: state });
    assert.equal(backup.status, 200);
    assert.ok(backup.xml.includes(`<Say>${fallbackMessage}</Say><Hangup/>`));
    assert.doesNotMatch(backup.xml, /<Dial/);
  }
});

test("a pause uses the fallback; temporary AI coverage returns to staff after expiry", async t => {
  const paused = await setup(t, { ...route, override: { mode: "paused" } });
  assert.ok((await paused.send()).xml.includes(route.fallbackNumber));
  const cover = await setup(t, { ...route, override: { mode: "cover_now", until: "2026-11-04T11:00:00+07:00" } });
  assert.ok((await cover.send()).xml.includes(route.aiNumber));
  cover.setTime("2026-11-04T04:00:00Z");
  assert.ok((await cover.send()).xml.includes(route.staffNumber));
});

test("local overnight hours extend into the next weekday", async t => {
  const api = await setup(t, { ...route, hours: { Wed: [["21:00", "02:00"]] } });
  api.setTime("2026-11-04T18:30:00Z");
  assert.ok((await api.send()).xml.includes(route.staffNumber));
  api.setTime("2026-11-04T19:00:00Z");
  assert.ok((await api.send()).xml.includes(route.aiNumber));
});

test("webhook rejects altered signatures, other Twilio accounts, and unknown ingress", async t => {
  const api = await setup(t);
  assert.equal((await api.send("/voice/inbound", form, "wrong-token")).status, 403);
  assert.equal((await api.send("/voice/inbound", { ...form, AccountSid: "AC" + "c".repeat(32) })).status, 403);
  assert.equal((await api.send("/voice/inbound", { ...form, To: "+12025550999" })).status, 404);
});

test("configuration rejects forwarding loops and shared AI numbers", () => {
  const make = rows => createVoiceIngress({ rawRoutes: JSON.stringify(rows), publicUrl: origin, authToken, accountSid });
  assert.throws(() => make([{ ...route, staffNumber: route.clinicNumber }]), /unsafe dial destination/);
  assert.throws(() => make([{ ...route, fallbackNumber: route.ingressNumber }]), /unsafe dial destination/);
  assert.throws(() => make([{ ...route, fallbackMessage: "Try again shortly." }]), /exactly one fallback/);
  assert.throws(() => make([{ ...route, fallbackNumber: undefined, fallbackMessage: " " }]), /exactly one fallback/);
  assert.throws(() => make([route, { ...route, ingressNumber: "+12025550201" }]), /unsafe dial destination/);
});
