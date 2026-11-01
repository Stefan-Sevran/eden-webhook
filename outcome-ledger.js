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
          subject: `Eden: ${row.kind.replaceAll(".", " ")} - ${row.clinic_id}`,
          text: [
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

  return { enabled, record, list, listBookings, dispatch };
}

module.exports = { outcomeKey, hasOpsAccess, parseAlertEmails, createOutcomeLedger };
