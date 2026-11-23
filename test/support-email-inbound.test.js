const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { test } = require("node:test");
const { createSupportEmailPreview } = require("../support-email-inbound");

test("only signed events for the pilot inbox can fetch a message and draft a reply", async () => {
  const secret = Buffer.alloc(32, 7);
  const receivingAddress = "eden-pilot@example.test";
  const id = "9ee3e289-9f24-4c46-bf7e-1dff281f36b4";
  const now = 1700000000;
  let receivedText = "I can’t find my access request.";
  let reads = 0;
  const handler = createSupportEmailPreview({
    receivingAddress, signingSecret:"whsec_" + secret.toString("base64"), receivingKey:"fixture",
    now:()=>now,
    fetchImpl:async (url,request) => {
      reads++;
      assert.equal(url,"https://api.resend.com/emails/receiving/" + id);
      assert.equal(request.headers.Authorization,"Bearer fixture");
      return Response.json({text:receivedText});
    }
  });
  function received(to, timestamp = now) {
    const body = Buffer.from(JSON.stringify({type:"email.received",data:{to:[to],email_id:id}}));
    const signature = createHmac("sha256",secret).update("evt." + timestamp + ".").update(body).digest("base64");
    return [body,{"svix-id":"evt","svix-timestamp":String(timestamp),"svix-signature":"v1,"+signature}];
  }
  const [body,headers] = received(receivingAddress);
  assert.equal((await createSupportEmailPreview({})(body,headers)).status,503);
  assert.equal((await handler(body,{})).status,401);
  assert.equal((await handler(Buffer.concat([body,Buffer.from(" ")]),headers)).status,401);
  assert.equal((await handler(...received(receivingAddress,now-301))).status,401);
  assert.equal((await handler(...received("team@clinicnet.live"))).body.status,"ignored");
  assert.equal(reads,0);
  assert.match((await handler(body,headers)).body.body,/open Alerts/);
  receivedText = "Please refund this payment. My patient’s name is Sample.";
  assert.deepEqual((await handler(body,headers)).body,{decision:"human"});
  receivedText = "This has no known support topic.";
  assert.deepEqual((await handler(body,headers)).body,{decision:"human"});
});
