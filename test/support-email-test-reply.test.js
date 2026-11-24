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

test("forwarded pilot replies to the configured tester in the original thread and directs follow-ups to the team", async () => {
  const id = "4ec07662-233f-4111-ad34-62b10f282e12";
  const now = 1000;
  const receivingAddress = "pilot@example.test";
  const teamAddress = "team@example.test";
  const originalMessageId = "<original@example.test>";
  const originalSubject = "Eden Team Inbox Test";
  const original = {
    from: teamAddress, to: [receivingAddress], subject: "Fw: " + originalSubject,
    message_id: "<forward@example.test>",
    text: "From: untrusted@example.test\nWhere do I review a support access request?"
  };
  const configuration = JSON.stringify({
    id, from: "eden@example.test", to: "tester@example.test", expiresAt: now + 60000,
    forwarded: {teamAddress, originalMessageId, originalSubject}
  });
  const sends = [];
  let received = original;
  const options = {
    configuration, receivingAddress, apiKey: "fixture", now,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/receiving/" + id)) return Response.json(received);
      assert.equal(url, "https://api.resend.com/emails");
      sends.push(JSON.parse(init.body));
      return Response.json({id: "fixture-response"});
    }
  };
  for (const mismatch of [
    {from: "unexpected@example.test"}, {subject: originalSubject},
    {subject: "Fw: unrelated test"}, {message_id: originalMessageId}
  ]) {
    received = {...original, ...mismatch};
    assert.equal(await sendSupportTestReply(options), "original_message_not_matched");
  }
  assert.equal(sends.length, 0);
  received = original;
  assert.equal(await sendSupportTestReply(options), "accepted_by_resend");
  assert.deepEqual(sends[0].to, ["tester@example.test"]);
  assert.equal(sends[0].reply_to, teamAddress);
  assert.equal(sends[0].subject, "Re: " + originalSubject);
  assert.equal(sends[0].headers["In-Reply-To"], originalMessageId);
  assert.equal(sends[0].headers.References, originalMessageId);
});
