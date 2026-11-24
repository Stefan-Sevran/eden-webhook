const assert = require('node:assert/strict');
const {test} = require('node:test');
const {draftKnowledgeSupportEmail} = require('../eden-support-draft');
const {supportKnowledge} = require('../eden-support-knowledge');

test('Eden gives grounded guidance across platform workflows and asks about mixed issues', async () => {
  const cases = [
    ["Eden asked for access but I can't find the request", /open Alerts/],
    ["We have suggested edits waiting for review", /approve or dismiss/],
    ["The latest sign-in link takes me to localhost", /intended Clinic Workspace/],
    ["I requested too many emails to sign in", /unused sign-in link/],
    ["Our receptionist widget is live but where can I see inquiries?", /Website Chat/],
    ["What Facebook Page should we connect?", /select Messenger/],
    ["My forwarded call did not connect", /Check test call/],
    ["How do I mark an appointment as booked?", /confirmed appointment date and time/],
    ["Why is a visit counted in this settlement?", /View counted visits/],
    ["Can I connect Google Calendar for booking?", /Which calendar or scheduling system/],
    ["Where can I update our opening hours?", /Clinic profile/],
    ["Where do I see the callback? Also, how do I set up Messenger?", /Which one would you like to solve first/]
  ];
  for (const [question, expected] of cases) {
    const reply = await draftKnowledgeSupportEmail(question, {apiKey:''});
    assert.equal(reply.decision, 'draft', question);
    assert.match(reply.body, expected, question);
  }
  assert.deepEqual(await draftKnowledgeSupportEmail('Where can I request a winning lifestyle?', {apiKey:''}),
    {decision:'human'});
  assert.equal(supportKnowledge('How do I update opening hours?').view, 'profile');
});

test('optional model can recover a paraphrase with the knowledge base and rejects unsupported sources', async () => {
  const question = 'How can my colleague see the items Eden has prepared for us?';
  const options = result => ({
    apiKey:'synthetic-key',
    fetchImpl:async (_url, request) => {
      const payload = JSON.parse(request.body);
      assert.equal(payload.store, false);
      assert.equal(payload.text.format.strict, true);
      assert.ok(JSON.parse(payload.input).guides.some(guide => guide.id === 'support-changes'));
      return Response.json({status:'completed', output:[{content:[{type:'output_text', text:JSON.stringify(result)}]}]});
    }
  });
  assert.match((await draftKnowledgeSupportEmail(question, options({
    decision:'answer', answer:'Ask your clinic owner to open Alerts and choose the changes that need review.',
    sources:['support-changes']
  }))).body, /open Alerts/);
  assert.deepEqual(await draftKnowledgeSupportEmail(question, options({
    decision:'answer', answer:'I checked your clinic.', sources:['invented']
  })), {decision:'human'});
  assert.deepEqual(await draftKnowledgeSupportEmail(question, {apiKey:'synthetic-key', fetchImpl:async () => Response.json({
    status:'completed', output:[{content:[{type:'refusal', refusal:'Unavailable'}]}]
  })}), {decision:'human'});
});

test('sensitive messages and the existing automatic reply stay off the model path', async () => {
  let calls = 0;
  const options = {apiKey:'synthetic-key', fetchImpl:async () => { calls++; throw Error('Unexpected model request'); }};
  assert.deepEqual(await draftKnowledgeSupportEmail('Where do I review patient records?', options), {decision:'human'});
  assert.deepEqual(await draftKnowledgeSupportEmail('Please issue a refund for this payment.', options), {decision:'human'});
  assert.match((await draftKnowledgeSupportEmail('Can verify@example.test sign in?', options)).body, /sign-in email/);
  assert.match((await draftKnowledgeSupportEmail('Hi Eden, where do I review a support access request?', options)).body, /open Alerts/);
  assert.equal(calls, 0);
});
