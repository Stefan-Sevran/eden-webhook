const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sendSupportTestReply } = require("../support-email-test-reply");

test("one pilot message supplies exact thread headers and a stable send key", async () => {
  const id = "635e83d3-4ad3-4216-b5b9-35fb16e05d95";
  const from = "support@example.test";
  const to = "user@example.test";
  const now = 1000;
  const pilotInbox = "eden@example.test";
  const configuration = JSON.stringify({id,to,from,expiresAt:now + 60000});
  const original = {from:"Tester <" + to + ">",to:[pilotInbox],subject:"Eden Pilot Test",
    message_id:"<original@example.test>",text:"I can’t find the access request."};
  const sends = [];
  let originalEmail = original;
  const options = { configuration, receivingAddress:pilotInbox, apiKey:"fixture",now,
    fetchImpl:async (url, init)=>{
      if (url.endsWith("/receiving/" + id)) return Response.json(originalEmail);
      assert.equal(url,"https://api.resend.com/emails");
      sends.push(init);
      return Response.json({id:"fixture-response"});
    }};
  assert.equal(await sendSupportTestReply({...options,configuration:undefined}),"disabled");
  assert.equal(await sendSupportTestReply({...options,now:now + 60000}),"invalid_or_expired_configuration");
  originalEmail = {...original,from:"different@example.test"};
  assert.equal(await sendSupportTestReply(options),"original_message_not_matched");
  assert.equal(sends.length,0);
  originalEmail = original;
  assert.equal(await sendSupportTestReply(options),"accepted_by_resend");
  assert.equal(await sendSupportTestReply(options),"accepted_by_resend");
  assert.equal(sends[0].headers["Idempotency-Key"],sends[1].headers["Idempotency-Key"]);
  const reply = JSON.parse(sends[0].body);
  assert.deepEqual(reply.to,[to]);
  assert.equal(reply.subject,"Re: Eden Pilot Test");
  assert.equal(reply.headers["In-Reply-To"],original.message_id);
  assert.equal(reply.headers.References,original.message_id);
  assert.match(reply.text,/open Alerts/);
});
