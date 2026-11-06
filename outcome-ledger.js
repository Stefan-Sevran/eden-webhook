const { createHash, timingSafeEqual } = require("node:crypto");

function outcomeKey(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function hasOpsAccess(header, key) {
  if (!key || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(key);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function parseAlertEmails(raw) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("CLINIC_ALERT_EMAILS must be a JSON object");
  }
  for (const [clinicId, email] of Object.entries(parsed)) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`Invalid alert email for clinic ${clinicId}`);
    }
  }
  return parsed;
}

function createOutcomeLedger({ url, key, resendKey, fromEmail, fetchImpl = fetch }) {
  const enabled = Boolean(url && key);
  const base = enabled ? `${url.replace(/\/$/, "")}/rest/v1` : "";

  async function database(path, options = {}) {
    const response = await fetchImpl(`${base}/${path}`, {
      ...options,
      headers: {
        apikey: key,
        "Content-Type": "application/json",
        ...options.headers
      }
    });
    if (!response.ok) {
      throw new Error(`Outcome database HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async function record(event) {
    if (!enabled) return { stored: false, reason: "ledger_not_configured" };
    const required = ["event_key", "clinic_id", "channel", "kind", "status", "summary"];
    if (required.some(field => !event[field])) throw new Error("Incomplete clinic outcome");
    const rows = await database("clinic_outcomes?on_conflict=event_key", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({
        event_key: event.event_key,
        clinic_id: event.clinic_id,
        ...(event.account_id ? { account_id: event.account_id } : {}),
        ...(event.location_id ? { location_id: event.location_id } : {}),
        channel: event.channel,
        kind: event.kind,
        status: event.status,
        summary: event.summary.slice(0, 500),
        details: event.details || {},
        notify_to: event.notify_to || null,
        notification_state: event.notify_to ? "pending" : "not_configured"
      })
    });
    return { stored: rows.length > 0, event: rows[0] || null };
  }

  async function list({ clinicId, limit = 50 } = {}) {
    if (!enabled) throw new Error("Outcome ledger is not configured");
    const params = new URLSearchParams({
      select: "event_key,clinic_id,channel,kind,status,summary,details,occurred_at,notification_state,notified_at",
      order: "occurred_at.desc",
      limit: String(Math.min(Math.max(Number(limit) || 50, 1), 100))
    });
    if (clinicId) params.set("clinic_id", `eq.${clinicId}`);
    return database(`clinic_outcomes?${params}`);
  }

  async function listBookings({ clinicId, limit = 50 } = {}) {
    if (!enabled) throw new Error("Outcome ledger is not configured");
    const params = new URLSearchParams({
      select: "event_key,clinic_id,channel,kind,status,summary,details,occurred_at,notification_state",
      order: "occurred_at.desc",
      limit: String(Math.min(Math.max(Number(limit) || 50, 1), 100))
    });
    if (clinicId) params.set("clinic_id", `eq.${clinicId}`);
    return database(`clinic_booking_cases?${params}`);
  }

  async function connectedLocation(accountId, locationId, channel) {
    if (!enabled) throw new Error("Outcome ledger is not configured");
    const locationParams = new URLSearchParams({
      select: "id,account_id,name,alert_email",
      id: `eq.${locationId}`, account_id: `eq.${accountId}`, limit: "1"
    });
    const locations = await database(`clinic_locations?${locationParams}`);
    if (!locations.length) return null;
    const connectionParams = new URLSearchParams({
      select: "id", account_id: `eq.${accountId}`,
      location_id: `eq.${locationId}`, channel: `eq.${channel}`,
      status: "eq.connected", limit: "1"
    });
    const connections = await database(`clinic_channel_connections?${connectionParams}`);
    return connections.length ? locations[0] : null;
  }

  async function recordDemoInquiry(accountId, locationId) {
    const params = new URLSearchParams({
      select: "id", id: `eq.${locationId}`, account_id: `eq.${accountId}`,
      name: "eq.Test Location", limit: "1"
    });
    if (!(await database(`clinic_locations?${params}`)).length) return null;
    const eventKey = outcomeKey("demo_braces_callback_v1", accountId, locationId);
    const { stored } = await record({
      event_key: eventKey, clinic_id: locationId, account_id: accountId, location_id: locationId,
      channel: "ai_phone", kind: "call.followup_needed", status: "NEEDS_CALLBACK",
      summary: "Sample inquiry · Braces consultation in Cebu",
      details: { demo: true, service: "Braces consultation",
        requestedTime: "Asked about Saturday availability" }
    });
    return { eventKey, stored };
  }

  async function provisionVoiceConnection(accountId, locationId, agentId, number) {
    if (!enabled) throw new Error("Outcome ledger is not configured");
    const locationParams = new URLSearchParams({
      select: "id", id: `eq.${locationId}`, account_id: `eq.${accountId}`, limit: "1"
    });
    if (!(await database(`clinic_locations?${locationParams}`)).length) return null;
    const params = new URLSearchParams({
      select: "id,account_id,location_id,status,external_id,forwarding_number",
      account_id: `eq.${accountId}`, location_id: `eq.${locationId}`,
      channel: "eq.ai_phone", status: "in.(requested,action_required)", limit: "1"
    });
    const rows = await database(`clinic_channel_connections?${params}`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "verifying", external_id: agentId,
        forwarding_number: number, updated_at: new Date().toISOString() })
    });
    return rows[0] || null;
  }

  async function voiceLocation(agentId, number) {
    if (!enabled) throw new Error("Outcome ledger is not configured");
    const params = new URLSearchParams({
      select: "id,account_id,location_id,status", channel: "eq.ai_phone",
      status: "in.(verifying,connected)", external_id: `eq.${agentId}`,
      forwarding_number: `eq.${number}`, limit: "2"
    });
    const routes = await database(`clinic_channel_connections?${params}`);
    if (routes.length !== 1) return null;
    const route = routes[0];
    const locationParams = new URLSearchParams({
      select: "id,account_id,name,alert_email", id: `eq.${route.location_id}`,
      account_id: `eq.${route.account_id}`, limit: "1"
    });
    const locations = await database(`clinic_locations?${locationParams}`);
    return locations.length ? { ...route, location: locations[0] } : null;
  }

  async function activateVoiceConnection(route) {
    const params = new URLSearchParams({
      select: "id", id: `eq.${route.id}`, account_id: `eq.${route.account_id}`,
      location_id: `eq.${route.location_id}`, status: "eq.verifying", limit: "1"
    });
    const rows = await database(`clinic_channel_connections?${params}`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "connected", updated_at: new Date().toISOString() })
    });
    return rows.length > 0;
  }

  async function provisionMessengerConnection(pageId, { accountId, locationId }) {
    const params = new URLSearchParams({
      select: "id,status", account_id: `eq.${accountId}`, location_id: `eq.${locationId}`,
      channel: "eq.facebook_messenger", status: "in.(requested,action_required)"
    });
    const rows = await database(`clinic_channel_connections?${params}`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "verifying", external_id: pageId, updated_at: new Date().toISOString() })
    });
    return rows[0] || await messengerLocation(pageId, { accountId, locationId });
  }

  async function messengerLocation(pageId, { accountId, locationId }) {
    const params = new URLSearchParams({
      select: "id,account_id,location_id,status", external_id: `eq.${pageId}`,
      account_id: `eq.${accountId}`, location_id: `eq.${locationId}`,
      channel: "eq.facebook_messenger", status: "in.(verifying,connected)", limit: "1"
    });
    const [route] = await database(`clinic_channel_connections?${params}`);
    if (!route) return null;
    const location = new URLSearchParams({
      select: "alert_email", id: `eq.${locationId}`, account_id: `eq.${accountId}`, limit: "1"
    });
    const [row] = await database(`clinic_locations?${location}`);
    return row ? { ...route, location: row } : null;
  }

  async function messengerCaseOpen(route, key) {
    const params = new URLSearchParams({
      select: "action", event_key: `eq.${key}`, account_id: `eq.${route.account_id}`,
      location_id: `eq.${route.location_id}`, limit: "1"
    });
    const [row] = await database(`clinic_followup_states?${params}`);
    return !["handled", "booked"].includes(row?.action);
  }

  async function messengerTurn(key) {
    const [row] = await database(`clinic_messenger_turns?event_key=eq.${key}&limit=1`);
    return row;
  }

  async function recentMessengerTurn(conversationKey) {
    const params = new URLSearchParams({
      conversation_key: `eq.${conversationKey}`,
      order: "received_at.desc,updated_at.desc,event_key", limit: "1"
    });
    const [row] = await database(`clinic_messenger_turns?${params}`);
    return row;
  }

  async function prepareMessengerTurn(turn) {
    const [row] = await database("clinic_messenger_turns?on_conflict=event_key", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(turn)
    });
    return row || await messengerTurn(turn.event_key);
  }

  async function updateMessengerTurn(key, expected, state, caseKey) {
    const rows = await database(`clinic_messenger_turns?event_key=eq.${key}&state=eq.${expected}`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ state, updated_at: new Date().toISOString(),
        ...(caseKey ? { case_key: caseKey } : {}) })
    });
    return rows.length > 0;
  }

  async function dispatch(batchSize = 10) {
    if (!enabled || !resendKey || !fromEmail) {
      return { claimed: 0, sent: 0, failed: 0, reason: "email_not_configured" };
    }
    const rows = await database("rpc/claim_clinic_notifications", {
      method: "POST",
      body: JSON.stringify({ batch_size: Math.min(Math.max(batchSize, 1), 20) })
    });
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        // The body is stable across retries, as required by Resend's idempotency key.
        const email = {
          from: fromEmail,
          to: [row.notify_to],
          subject: row.account_id ? "New activity in your Eden Clinic Workspace" :
            `Eden: ${row.kind.replaceAll(".", " ")} - ${row.clinic_id}`,
          text: row.account_id
            ? "There is new activity for your clinic. Sign in to view it: https://clinicnet.live/clinic/"
            : [
            row.summary,
            `Clinic: ${row.clinic_id}`,
            `Channel: ${row.channel}`,
            `Status: ${row.status}`,
            `Patient: ${row.details?.patientName || "Not captured"}`,
            `Contact: ${row.details?.contact || "Not captured"}`,
            `Service: ${row.details?.service || "Not captured"}`,
            `Requested time: ${row.details?.requestedTime || "Not captured"}`,
            `Event: ${row.event_key}`
          ].join("\n")
        };
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": row.event_key
          },
          body: JSON.stringify(email)
        });
        if (!response.ok) throw new Error(`Email HTTP ${response.status}`);
        await database(`clinic_outcomes?event_key=eq.${row.event_key}&notification_state=eq.sending`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            notification_state: "sent",
            notified_at: new Date().toISOString(),
            notification_error: null
          })
        });
        sent++;
      } catch (error) {
        failed++;
        await database(`clinic_outcomes?event_key=eq.${row.event_key}&notification_state=eq.sending`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            notification_state: "retry",
            notification_error: String(error.message).slice(0, 100)
          })
        });
      }
    }
    return { claimed: rows.length, sent, failed };
  }

  return { enabled, record, list, listBookings, connectedLocation, recordDemoInquiry,
    provisionVoiceConnection, voiceLocation, activateVoiceConnection, dispatch,
    provisionMessengerConnection, messengerLocation, activateMessengerConnection: activateVoiceConnection,
    messengerCaseOpen, messengerTurn, recentMessengerTurn, prepareMessengerTurn, updateMessengerTurn };
}

module.exports = { outcomeKey, hasOpsAccess, parseAlertEmails, createOutcomeLedger };
