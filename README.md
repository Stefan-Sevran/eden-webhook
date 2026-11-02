# eden-webhook

## Messenger deployment

This service currently handles the Eden Clinic Network Page only. It is not yet
the multi-clinic connection flow.

Set these Render environment variables before deploying:

- `META_APP_SECRET`: the secret for the Meta app whose callback points to this
  service. Required to verify signed webhook requests; the endpoint returns 503
  until it is set.
- `PAGE_ACCESS_TOKEN`: a Page access token for Eden Clinic Network.
- `OPENAI_API_KEY`: the OpenAI API key.
- `META_PAGE_ID`: optional; defaults to Eden Clinic Network's current Page ID.

The existing Meta webhook callback URL and verification token do not need to
change. Do not paste the app secret or Page token into a chat or source file.

Run `npm ci` and `node --test test/*.test.js` before deployment. Then send one
message to the Page from an authorized test account and verify that Messenger
shows exactly one reply with Eden Clinic Network branding. The Meta app is in
development mode, so broader public access still requires its permissions and
publishing process.

The deduplication guard is held in process memory. Run one web instance for this
pilot; a durable event inbox with a unique `(page_id, message_id)` constraint is
required before scaling to multiple workers or Pages.

## Unified outcome ledger (staged rollout)

The optional ledger replaces Google Sheets as the record of booking requests,
follow-up updates, AI call events, and Eden Messenger inquiries. Existing pilot
behavior remains available until it is configured. Run `sql/clinic-outcomes.sql`
once in the Supabase SQL editor, then set the following **server-only** Render
environment variables on `eden-webhook`:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SECRET_KEY` | Supabase secret/server key; never put it in a browser or commit. |
| `OPS_API_KEY` | Long random key for the internal outcome and booking queue endpoints. |
| `BOOKING_INGEST_KEY` | Separate long random key for a connected booking form's server. |
| `CLINIC_ALERT_EMAILS` | JSON map, for example `{"pearlsmile":"staff@example.com"}`. Use real approved staff inboxes; demo contact addresses are not used. |
| `EDEN_ALERT_EMAIL` | Optional Eden team inbox for qualified acquisition leads. |
| `RESEND_API_KEY` and `RESEND_FROM_EMAIL` | Resend key and verified sender for staff email alerts. |
| `ELEVEN_WEBHOOK_SECRET` | ElevenLabs post-call webhook signing secret. Required when the ledger is enabled; unsigned post-call requests then return 503. |

Both Supabase variables are needed to enable the ledger. Once enabled, booking,
lead, follow-up, and call paths stop writing to Google Sheets. If a clinic's
alert email or Resend is not yet configured, its existing Telegram alert path
remains as a fallback. The email sender claims pending events in the database,
uses an idempotency key per event, and records send or retry state. A fast
dispatch runs after each new event; for recovery after process restarts, arrange
an external scheduler to POST `/ops/dispatch-notifications` with
`Authorization: Bearer <OPS_API_KEY>` every minute. Render's free instance can
sleep, so this scheduler and its cold-start allowance are necessary before
claiming dependable alert delivery. Inspect failed attempts in the outcome feed.

Internal, server-only endpoints (all require the ops bearer key):

- `GET /ops/outcomes?clinicId=pearlsmile` returns the recent event feed.
- `GET /ops/bookings?clinicId=pearlsmile` returns the latest state for each
  booking ID, including cancellations. These endpoints expose patient contact
  data; never call them from an untrusted browser with the ops key.
- `POST /ops/dispatch-notifications` retries pending staff email alerts.

A connected booking form's backend can POST `/integrations/booking-events` with
the ingest bearer key and JSON fields `clinicId`, `sourceEventId`, `bookingId`,
`kind` (`booking.requested`, `booking.updated`, or `booking.cancelled`),
`patientName`, `contact`, `service`, and `requestedTime`. The optional `status`
for `booking.updated` may be `AWAITING_CLINIC`, `CONFIRMED`, or
`RESCHEDULE_REQUESTED`. A repeated `sourceEventId` is stored once. This route
must be called server-to-server, never with the key exposed in a form page.
The current clinic IDs are demo configurations; each real clinic needs its own
approved Page, booking source, alert recipient, and access policy.

The ledger records requests and patient replies; it does not infer a paid visit.
Paid-visit reconciliation requires a connected payment or clinic record source.
The existing patient booking sessions and Messenger reply deduplication remain
in process memory, so this is a single-service pilot, not a multi-clinic
production launch. The ops endpoints are an internal JSON view; a tenant-scoped
staff workspace and a durable message inbox are still needed for clinic rollout.

## Account and location foundation

After the ledger schema, run `sql/clinic-tenancy.sql` in the Supabase SQL editor.
Set `SUPABASE_PUBLISHABLE_KEY` on Render for user-scoped API requests. This key
can be used by a future client application; the existing `SUPABASE_SECRET_KEY`
must stay server-only. Clinic endpoints verify the Supabase Auth access token
with the Auth server and query PostgREST with that user's token, so database
row-level policies restrict each account's records. The old Eden/demo events
are unassigned and invisible to clinic users.

With `Authorization: Bearer <Supabase Auth access token>`:

| Endpoint | Role and result |
| --- | --- |
| `POST /clinic/onboard` | Signed-in user creates an account and first location from `accountName` and `locationName`, becoming owner. |
| `GET /clinic/accounts` | Lists accounts belonging to the signed-in user. |
| `GET /clinic/locations?accountId=...` | Lists that account's locations. |
| `POST /clinic/locations` | Owner/admin adds a location with `accountId`, `name`, and IANA `timezone`. |
| `GET /clinic/connections?accountId=...` | Lists channel connection statuses; optional `locationId`. |
| `POST /clinic/connections` | Owner/admin requests a `website_chat`, `facebook_messenger`, or `ai_phone` connection using `accountId` and `locationId`. This cannot mark it connected. |
| `GET /clinic/inbox?accountId=...` | Recent tenant outcomes; optional `locationId` and `limit`. |
| `GET /clinic/followups?accountId=...` | Latest staff action per outcome, scoped by account and optional `locationId`. |
| `POST /clinic/followups` | Signed-in member appends `handled` or `reopened` for a call or booking request using `accountId`, `locationId`, `eventKey`, and `action`. The actor is taken from the verified session. |
| `GET /clinic/bookings?accountId=...` | Latest state per tenant booking; optional `locationId` and `limit`. |

The connected booking-form backend can call
`POST /integrations/tenant-booking-events` with `BOOKING_INGEST_KEY` and
`accountId`, `locationId`, `sourceEventId`, `bookingId`, `kind`, `patientName`,
`contact`, `service`, and `requestedTime` (optional `status` for updates).
The service looks up a `connected` website channel for the location and stores
the account/location IDs itself. It returns 409 until that connection is
verified. The key must never appear in a browser or downloaded widget.

This is an API foundation, not a clinic-facing application. The connection
request does not perform Meta authorization, domain verification, or phone
forwarding. Staff invitations, an actual inbox interface, durable booking
sessions, channel credential storage/rotation, a verified appointment source,
and a payment source are still required before self-serve clinic launch.

### AI phone pilot routing

Apply `sql/clinic-voice-connections.sql` and then
`sql/clinic-followup-actions.sql` after the tenant schema. An owner first
requests `ai_phone` for a location. An operator configures a **dedicated**
ElevenLabs agent and E.164 destination number, sets the forwarding from the
clinic's existing number, and calls `POST /ops/voice-connections` with
`Authorization: Bearer <OPS_API_KEY>` and JSON `accountId`, `locationId`,
`agentId`, `forwardingNumber` (the destination on ElevenLabs, not the clinic's
public number). The connection becomes `verifying`. A signed inbound
`post_call_transcription` webhook to `/eleven-postcall` must carry the same
agent and called destination; it adds a tenant-scoped call to the clinic inbox
and changes the connection to `connected`. A different agent, number, or
outbound call cannot activate it. Provide `ELEVEN_WEBHOOK_SECRET` on Render.

Configure the agent's server-side booking tool to call
`POST /integrations/tenant-voice-booking-events` with
`Authorization: Bearer <BOOKING_INGEST_KEY>` and `agentId`, `calledNumber`,
`conversationId`, `sourceEventId`, `patientName`, `contact`, `service`,
`requestedTime`. The tool must use the actual inbound destination and a stable
source event ID. Only a connected route can create `booking.requested`, and it
remains awaiting staff confirmation. Set a location `alert_email` and configure
Resend for durable email alerts; otherwise the call is visible in the inbox
with notification state `not_configured`. This is not automated carrier
forwarding setup, appointment confirmation, or SMS activation.

Staff actions are append-only and tenant-scoped in `clinic_followup_actions`.
The current state comes from the invoker-security `clinic_followup_states`
view. Marking a booking request handled records staff follow-up, not a
confirmed appointment or paid visit.
