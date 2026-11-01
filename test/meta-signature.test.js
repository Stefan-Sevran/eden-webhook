const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { hasValidMetaSignature } = require("../meta-signature");

test("validates Meta's signature against the original request bytes", () => {
  const rawBody = Buffer.from('{"text":"สวัสดี","spacing":  1}', "utf8");
  const signature = "sha256=" + crypto.createHmac("sha256", "app-secret")
    .update(rawBody).digest("hex");
  assert.equal(hasValidMetaSignature(rawBody, signature, "app-secret"), true);
  assert.equal(hasValidMetaSignature(Buffer.from(JSON.stringify(JSON.parse(rawBody))), signature, "app-secret"), false);
  assert.equal(hasValidMetaSignature(rawBody, signature, "wrong-secret"), false);
  assert.equal(hasValidMetaSignature(rawBody, "sha256=bad", "app-secret"), false);
});
