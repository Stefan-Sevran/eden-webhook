const { createHmac, timingSafeEqual } = require("node:crypto");
const { draftEdenSupportEmail } = require("./eden-support-email");

function verifyResendEvent(raw, headers, secret, now) {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatures = headers["svix-signature"];
  if (!Buffer.isBuffer(raw) || typeof id !== "string" || !id ||
    typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 300 || typeof signatures !== "string" ||
    !/^whsec_[a-zA-Z0-9+/]+={0,2}$/.test(secret)) return false;

  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 16) return false;
  const digest = createHmac("sha256", key).update(id + "." + timestamp + ".").update(raw).digest();
  return signatures.split(/\s+/).some(signature => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
    return timingSafeEqual(digest, Buffer.from(signature.slice(3), "base64"));
  });
}

function createSupportEmailPreview({
  receivingAddress, signingSecret, receivingKey, fetchImpl = fetch,
  now = () => Math.floor(Date.now() / 1000)
}) {
  const address = receivingAddress?.trim().toLowerCase();
  return async function preview(raw, headers) {
    if (!address || !signingSecret || !receivingKey) return {status:503, body:{status:"not_configured"}};
    if (!verifyResendEvent(raw, headers, signingSecret, now())) return {status:401, body:{status:"unauthorized"}};

    let event;
    try { event = JSON.parse(raw.toString("utf8")); }
    catch { return {status:400, body:{status:"invalid_event"}}; }
    if (event?.type !== "email.received" || !Array.isArray(event.data?.to) ||
      !event.data.to.some(to => typeof to === "string" && to.trim().toLowerCase() === address)) {
      return {status:200, body:{status:"ignored"}};
    }
    const id = event.data.email_id;
    if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      return {status:400, body:{status:"invalid_id"}};
    }
    try {
      const response = await fetchImpl("https://api.resend.com/emails/receiving/" + id, {
        headers:{Authorization:"Bearer " + receivingKey}, signal:AbortSignal.timeout(10000)
      });
      if (!response.ok) return {status:502, body:{status:"receiving_unavailable"}};
      const received = await response.json();
      const draft = draftEdenSupportEmail(typeof received?.text === "string" ? received.text : "");
      // The response contains fixed guidance only. The original message stays with the mail provider.
      return {status:200, body:draft};
    } catch {
      return {status:502, body:{status:"receiving_unavailable"}};
    }
  };
}

module.exports = { createSupportEmailPreview };
