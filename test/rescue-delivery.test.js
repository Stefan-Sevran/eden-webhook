const test = require('node:test');
const assert = require('node:assert/strict');
const {runRescueReports} = require('../rescue-delivery');
test('signed-in workspace link, stable delivery key and ack only on success',async()=>{
  const env={SUPABASE_URL:'https://database.example.test',SUPABASE_SECRET_KEY:'sb_secret_test',RESEND_API_KEY:'test',RESEND_FROM_EMAIL:'eden@example.test'};
  const delivery={report_id:'report',account_id:'account',location_id:'location',recipient:'clinic@example.test',token:'lease'};
  async function run(status) {
    const calls=[];
    await runRescueReports(env,async(url,options)=>{
      const path=new URL(url).pathname; calls.push({path,options});
      if(path.endsWith('claim_rescue_mail'))return Response.json([delivery]);
      return new Response(null,{status:path==='/emails'?status:204});
    });
    return calls;
  }
  const failed=await run(503);assert.ok(!failed.some(c=>c.path.endsWith('ack_rescue_mail')));
  const sent=await run(200);
  const mail=sent.find(c=>c.path==='/emails').options;
  assert.equal(mail.headers['Idempotency-Key'],failed.at(-1).options.headers['Idempotency-Key']);
  const body=JSON.parse(mail.body);assert.deepEqual(body.to,[delivery.recipient]);
  assert.match(body.text,/clinicnet\.live\/clinic\/\?account=account&location=location&view=daily&report=report/);
  assert.equal(sent.at(-1).path,'/rest/v1/rpc/ack_rescue_mail');
});
