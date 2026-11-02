// Run against a migrated Supabase project with two unrelated disposable Auth users.
// Never use staff accounts or real patient data for this test.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY',
  'CLINIC_TEST_TOKEN_A', 'CLINIC_TEST_TOKEN_B', 'CLINIC_TEST_API_BASE'];
for (const key of required) if (!process.env[key]) throw Error(`Missing ${key}`);
const project = process.env.SUPABASE_URL.replace(/\/$/, '');
const api = process.env.CLINIC_TEST_API_BASE.replace(/\/$/, '');
const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
const tokens = [process.env.CLINIC_TEST_TOKEN_A, process.env.CLINIC_TEST_TOKEN_B];
const prefix = `isolation-${randomUUID()}`;
const accounts = [];
const eventKeys = [];

async function call(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: {
    Authorization: `Bearer ${token}`, ...(url.startsWith(project) ? { apikey: token === secret ? secret : anon } : {}),
    ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers
  } });
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : null; } catch { data = null; }
  return { status: response.status, data };
}
const app = (path, who, options) => call(api + path, tokens[who], options);
const query = id => `?accountId=${encodeURIComponent(id)}`;

try {
  const users = await Promise.all(tokens.map(token => call(project + '/auth/v1/user', token)));
  users.forEach(user => assert.equal(user.status, 200, 'A valid test token is required'));
  assert.notEqual(users[0].data.id, users[1].data.id, 'Use two unrelated test users');
  for (let who = 0; who < 2; who++) {
    const response = await app('/clinic/onboard', who, { method: 'POST', body: JSON.stringify({
      accountName: `${prefix}-${who}`, locationName: `Test location ${who}`
    }) });
    assert.equal(response.status, 200, 'Apply clinic-outcomes.sql then clinic-tenancy.sql first');
    accounts.push(response.data);
  }
  const locations = [];
  for (let who = 0; who < 2; who++) {
    const own = await app('/clinic/accounts', who);
    assert.equal(own.status, 200);
    assert(own.data.some(row => row.id === accounts[who]));
    assert(!own.data.some(row => row.id === accounts[1-who]), 'Foreign account leaked');
    const ownLocations = await app('/clinic/locations' + query(accounts[who]), who);
    assert.equal(ownLocations.status, 200);
    assert.equal(ownLocations.data.length, 1);
    locations.push(ownLocations.data[0].id);
    const foreignLocations = await app('/clinic/locations' + query(accounts[1-who]), who);
    assert.equal(foreignLocations.status, 200);
    assert.deepEqual(foreignLocations.data, [], 'Foreign location leaked');
  }
  for (let who = 0; who < 2; who++) {
    const eventKey = createHash('sha256').update(`${prefix}-${who}`).digest('hex');
    eventKeys.push(eventKey);
    const inserted = await call(project + '/rest/v1/clinic_outcomes', secret, {
      method: 'POST', body: JSON.stringify({
        event_key: eventKey, account_id: accounts[who], location_id: locations[who],
        clinic_id: `isolation-${who}`, channel: 'website_chat', kind: 'booking.requested',
        status: 'pending', summary: `Synthetic request ${who}`,
        details: { bookingId: eventKey }, notification_state: 'not_configured'
      })
    });
    assert.equal(inserted.status, 201, 'Could not seed synthetic booking');
  }
  for (let who = 0; who < 2; who++) {
    for (const path of ['/clinic/inbox', '/clinic/bookings']) {
      const own = await app(path + query(accounts[who]), who);
      assert.equal(own.status, 200);
      assert(own.data.some(row => row.event_key === eventKeys[who]), `${path}: own event missing`);
      const foreign = await app(path + query(accounts[1-who]), who);
      assert.equal(foreign.status, 200);
      assert.deepEqual(foreign.data, [], `${path}: foreign event leaked`);
    }
    const foreignConnections = await app('/clinic/connections' + query(accounts[1-who]), who);
    assert.equal(foreignConnections.status, 200);
    assert.deepEqual(foreignConnections.data, [], 'Foreign connections leaked');
    const ownAction = await app('/clinic/followups', who, { method: 'POST',
      body: JSON.stringify({ accountId: accounts[who], locationId: locations[who],
        eventKey: eventKeys[who], action: 'handled' }) });
    assert.equal(ownAction.status, 200, 'Own follow-up action was rejected');
    const ownStates = await app('/clinic/followups' + query(accounts[who]), who);
    assert.equal(ownStates.status, 200);
    assert(ownStates.data.some(row => row.event_key === eventKeys[who] &&
      row.action === 'handled'), 'Own follow-up state missing');
    const foreignStates = await app('/clinic/followups' + query(accounts[1-who]), who);
    assert.equal(foreignStates.status, 200);
    assert.deepEqual(foreignStates.data, [], 'Foreign follow-up state leaked');
    const foreignAction = await app('/clinic/followups', who, { method: 'POST',
      body: JSON.stringify({ accountId: accounts[1-who], locationId: locations[1-who],
        eventKey: eventKeys[1-who], action: 'handled' }) });
    assert.notEqual(foreignAction.status, 200, 'Foreign follow-up action accepted');
    assert.notEqual(foreignAction.status, 201, 'Foreign follow-up action accepted');
    const denied = await app('/clinic/locations', who, { method: 'POST', body: JSON.stringify({
      accountId: accounts[1-who], name: 'Intruder test', timezone: 'Asia/Manila'
    }) });
    assert.notEqual(denied.status, 200, 'Foreign account accepted location write');
    assert.notEqual(denied.status, 201, 'Foreign account accepted location write');
  }
  console.log('PASS: two real users, tenant inbox and booking isolation, follow-up reads and writes, connection reads, and denied cross-account writes.');
} finally {
  // Clean only records created by this run. A cleanup failure must be visible.
  for (const eventKey of eventKeys) {
    const result = await call(project + '/rest/v1/clinic_outcomes?event_key=eq.' + encodeURIComponent(eventKey), secret, { method: 'DELETE' });
    if (result.status !== 204) console.error('Cleanup failed for synthetic event:', result.status);
  }
  for (const id of accounts) {
    const result = await call(project + '/rest/v1/clinic_accounts?id=eq.' + encodeURIComponent(id), secret, { method: 'DELETE' });
    if (result.status !== 204) console.error('Cleanup failed for test account:', result.status);
  }
}
