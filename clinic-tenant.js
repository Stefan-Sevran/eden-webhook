const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createClinicTenantApi({ url, publishableKey, fetchImpl = fetch }) {
  const enabled = Boolean(url && publishableKey);
  const base = enabled ? url.replace(/\/$/, "") : "";

  async function authenticate(header) {
    if (!enabled) return { error: 503 };
    if (!header?.startsWith("Bearer ")) return { error: 401 };
    const token = header.slice(7);
    if (!token || token.length > 4096) return { error: 401 };
    const response = await fetchImpl(`${base}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return { error: 401 };
    const user = await response.json();
    if (!UUID.test(user.id || "")) return { error: 401 };
    return { token, userId: user.id };
  }

  async function request(token, path, { method = "GET", body, prefer } = {}) {
    const response = await fetchImpl(`${base}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      // Never reflect a database error containing patient or account data.
      const error = new Error(`Clinic data HTTP ${response.status}`);
      error.status = response.status === 401 || response.status === 403 ? 403 :
        response.status === 409 ? 409 : 503;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  function scopedPath(table, accountId, { locationId, limit = 50 } = {}) {
    if (!UUID.test(accountId || "") || (locationId && !UUID.test(locationId))) {
      const error = new Error("Invalid account or location ID");
      error.status = 400;
      throw error;
    }
    const params = new URLSearchParams({ account_id: `eq.${accountId}` });
    if (locationId) params.set("location_id", `eq.${locationId}`);
    if (table === "clinic_outcomes" || table === "clinic_booking_cases") {
      params.set("select", "event_key,account_id,location_id,channel,kind,status,summary,details,occurred_at,notification_state");
      params.set("order", "occurred_at.desc");
      params.set("limit", String(Math.min(Math.max(Number(limit) || 50, 1), 100)));
    } else if (table === "clinic_locations") {
      params.set("select", "id,account_id,name,timezone,alert_email,created_at");
    } else if (table === "clinic_channel_connections") {
      params.set("select", "id,account_id,location_id,channel,status,external_id,forwarding_number,updated_at");
    } else if (table === "clinic_followup_states") {
      params.set("select", "event_key,account_id,location_id,action,actor_user_id,created_at");
    }
    return `${table}?${params}`;
  }

  async function listAccounts(token) {
    return request(token, "clinic_accounts?select=id,name,created_at&order=created_at.desc");
  }

  async function onboard(token, accountName, locationName) {
    if (![accountName, locationName].every(value =>
      typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 120)) {
      const error = new Error("Account and location names are required");
      error.status = 400;
      throw error;
    }
    return request(token, "rpc/create_clinic_account", {
      method: "POST", body: { account_name: accountName.trim(), location_name: locationName.trim() }
    });
  }

  async function requestConnection(token, { accountId, locationId, channel }) {
    scopedPath("clinic_locations", accountId, { locationId });
    if (!["website_chat", "facebook_messenger", "ai_phone"].includes(channel)) {
      const error = new Error("Invalid channel");
      error.status = 400;
      throw error;
    }
    return request(token, "clinic_channel_connections", {
      method: "POST", prefer: "return=representation",
      body: { account_id: accountId, location_id: locationId, channel, status: "requested" }
    });
  }

  async function addLocation(token, { accountId, name, timezone }) {
    scopedPath("clinic_locations", accountId);
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 120 ||
        typeof timezone !== "string" || timezone.length > 80 ||
        !/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/.test(timezone)) {
      const error = new Error("Invalid location name or timezone");
      error.status = 400;
      throw error;
    }
    return request(token, "clinic_locations", {
      method: "POST", prefer: "return=representation",
      body: { account_id: accountId, name: name.trim(), timezone }
    });
  }

  async function appendFollowup(token, userId, { accountId, locationId, eventKey, action }) {
    scopedPath("clinic_locations", accountId, { locationId });
    if (!UUID.test(userId || "") || !/^[a-f0-9]{64}$/.test(eventKey || "") ||
        !["handled", "reopened"].includes(action)) {
      const error = new Error("Invalid follow-up action");
      error.status = 400;
      throw error;
    }
    return request(token, "clinic_followup_actions", {
      method: "POST", prefer: "return=representation",
      body: { account_id: accountId, location_id: locationId,
        event_key: eventKey, actor_user_id: userId, action }
    });
  }

  return { enabled, authenticate, request, scopedPath, listAccounts, onboard,
    requestConnection, addLocation, appendFollowup };
}

module.exports = { createClinicTenantApi, isUuid: value => UUID.test(value || "") };
