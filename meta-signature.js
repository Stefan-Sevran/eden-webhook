const crypto = require("node:crypto");

function hasValidMetaSignature(rawBody, signature, appSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody) ||
      !/^sha256=[a-f0-9]{64}$/i.test(signature || "")) return false;
  const received = Buffer.from(signature.slice(7), "hex");
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest();
  return crypto.timingSafeEqual(received, expected);
}

module.exports = { hasValidMetaSignature };
