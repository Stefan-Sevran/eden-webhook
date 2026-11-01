const { createHmac, timingSafeEqual } = require("node:crypto");

function hasValidElevenSignature(rawBody, header, secret, nowSeconds = Date.now() / 1000) {
  if (!rawBody || !header || !secret) return false;
  const fields = Object.fromEntries(header.split(",").map(part => part.trim().split("=", 2)));
  const timestamp = Number(fields.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 30 * 60) return false;
  if (!/^[a-f0-9]{64}$/i.test(fields.v0 || "")) return false;
  const expected = createHmac("sha256", secret)
    .update(String(timestamp)).update(".").update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(fields.v0, "hex"));
}

module.exports = { hasValidElevenSignature };
