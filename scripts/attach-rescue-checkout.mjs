// Attach a checkout issued by Eden's payment provider to an approved settlement.
const [reportId, currency, amount, rawUrl] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/i.test(reportId || '') || !/^(PHP|THB|USD)$/.test(currency || '') ||
    !/^\d{1,10}(\.\d{1,2})?$/.test(amount || '')) {
  throw Error('Supply report UUID, currency, approved share in major units and provider checkout URL.');
}
const link = new URL(rawUrl);
if (link.protocol !== 'https:' || link.username || link.password || !link.pathname.slice(1) || link.href.length > 512) {
  throw Error('Use the HTTPS payment link issued for this settlement.');
}
const key = process.env.SUPABASE_SECRET_KEY;
if (!key || !process.env.SUPABASE_URL) throw Error('Run in the configured Eden webhook environment.');
const headers = {apikey:key, 'Content-Type':'application/json', Prefer:'return=representation'};
if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
const [whole, cents=''] = amount.split('.');
const minor = Number(whole)*100 + Number(cents.padEnd(2,'0'));
const endpoint = new URL('/rest/v1/clinic_rescue_reports',process.env.SUPABASE_URL);
endpoint.search = new URLSearchParams({id:'eq.'+reportId,kind:'eq.settlement',approved_at:'not.is.null',
  'snapshot->>currency':'eq.'+currency,'snapshot->>share_minor':'eq.'+minor,select:'id,checkout_url'});
const response = await fetch(endpoint,{headers});
if (!response.ok) throw Error('Could not read approved settlement.');
const [report] = await response.json();
if (!report || minor === 0) throw Error('No approved payable settlement matches these figures.');
if (report.checkout_url === link.href) { console.log('Payment link already attached.'); }
else {
  endpoint.searchParams.set('checkout_url','is.null');
  const saved=await fetch(endpoint,{method:'PATCH',headers,body:JSON.stringify({checkout_url:link.href})});
  if (!saved.ok || !(await saved.json()).length) throw Error('Settlement already has a payment link or changed. Review it in Workspace.');
  console.log('Payment link and QR available on the approved report.');
}
