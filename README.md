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
