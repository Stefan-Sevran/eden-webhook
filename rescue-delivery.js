'use strict';

async function runRescueReports(env, fetchImpl = fetch) {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!base || !key) return;
  const headers = {apikey: key, 'Content-Type': 'application/json'};
  if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
  async function rpc(name, args = {}) {
    const response = await fetchImpl(new URL('/rest/v1/rpc/' + name, base), {
      method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw Error(name + ' failed (HTTP ' + response.status + ')');
    return response;
  }
  await rpc('generate_due_rescue_reports');
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return;
  const deliveries = await (await rpc('claim_rescue_mail')).json();
  for (const item of deliveries) {
    const url = new URL('https://clinicnet.live/clinic/');
    url.search = new URLSearchParams({account:item.account_id,location:item.location_id,view:'daily',report:item.report_id});
    try {
      const result = await fetchImpl('https://api.resend.com/emails', {
        method:'POST', headers:{Authorization:'Bearer ' + env.RESEND_API_KEY,'Content-Type':'application/json',
          'Idempotency-Key':'clinic-rescue-' + item.report_id},
        body: JSON.stringify({from:env.RESEND_FROM_EMAIL,to:[item.recipient],subject:'Your Revenue Rescue Report',
          text:'Your approved Revenue Rescue Report is ready. Open it in Clinic Workspace to review the results.\n\n' + url.href}),
        signal:AbortSignal.timeout(15000)
      });
      if (!result.ok) throw Error('provider HTTP ' + result.status);
      await rpc('ack_rescue_mail',{p_report:item.report_id,p_token:item.token});
    } catch (error) {
      console.error('Revenue Rescue email delivery needs retry', item.report_id, error.message);
    }
  }
}

function startRescueReports(env) {
  let active = false;
  async function tick() {
    if (active) return;
    active = true;
    try { await runRescueReports(env); }
    catch (error) { console.error('Revenue Rescue report job', error.message); }
    finally { active = false; }
  }
  const timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref();
  void tick();
}
module.exports = {runRescueReports,startRescueReports};
