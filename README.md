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

### Clinic booking outcome pilot

Apply `sql/clinic-booking-outcomes.sql` after the follow-up actions schema.
Deploy the API before publishing the Clinic Workspace changes. To seed the
fictional Cebu inquiry, an operator can call `POST /ops/demo-inquiry` with
`Authorization: Bearer <OPS_API_KEY>` and the Test Location's `accountId`
and `locationId`. Repeating the request returns the same event key.

In Test Location, claim the sample in the Activity inbox, then mark it booked.
It appears in Booked outcomes under the sample count. The sample contains no
patient contact and sends no email. For real inquiries, staff use Mark booked
after confirming an appointment. This is a staff-recorded outcome, separate
from attendance, payment, and invoice reporting.


### Incoming voice router (opt-in pilot)

Keep the verified ElevenLabs destination on its native Twilio integration.
Use a separate, approved Twilio ingress number for the pilot. Set its incoming
Voice webhook to POST `<VOICE_ROUTER_BASE_URL>/voice/inbound`. Use a
provider-hosted TwiML fallback for ingress webhook failures, with a tested
backup destination or message. The backup and staff lines must be direct destinations
that cannot forward back to the clinic or the router.

Server configuration:

- `VOICE_ROUTER_BASE_URL` is the exact public HTTPS origin Twilio calls.
- `TWILIO_VOICE_ACCOUNT_SID` and `TWILIO_VOICE_AUTH_TOKEN` identify the Twilio
  account owning the ingress numbers and validate signed POSTs.
- `VOICE_ROUTER_ROUTES` is a JSON array keyed internally by ingress number.
  Use the same dedicated AI destination already verified for that clinic
  workspace. The examples below contain fictional phone numbers.

```json
[
  {
    "mode": "managed",
    "ingressNumber": "+12025550101",
    "clinicNumber": "+12025550102",
    "staffNumber": "+12025550103",
    "aiNumber": "+12025550104",
    "fallbackNumber": "+12025550105",
    "timeZone": "Asia/Manila",
    "ringSeconds": 25,
    "hours": { "Mon": [["09:00", "18:00"]], "Tue": [["09:00", "18:00"]] }
  }
]
```

Each route requires one fallback. Set `fallbackNumber` to dial a backup line,
or set `fallbackMessage` to speak a short message and end the call. A message
lets the pilot run with just the ingress and AI numbers. It applies when the
AI leg is busy, unanswered, or fails, and when the route is paused.

With `managed` routing, staff ring first during configured open hours and
the agent takes over on no answer, busy, or a failed staff leg. The agent
answers first outside those hours. Omitted hours mean staff ring first at
all times. Set the staff timeout with enough margin for the staff line's
voicemail pickup, and test it on the real carrier.

For a clinic on carrier-side conditional forwarding, set `mode` to
`conditional_forwarding`. The carrier handles staff ringing and forwards
only missed calls to the ingress. The router sends those calls directly to
the AI at all hours. The carrier controls the original ring time and which
destinations are supported. Avoid dialling the public clinic number as a
staff or fallback leg. The router uses a second PSTN leg to the native
agent number, so verify caller ID, latency, and costs on the pilot route.

An optional `override` object can use `"mode": "paused"` to route to the
fallback, or `"mode": "cover_now"` for immediate AI. `cover_now` requires an
`until` timestamp with an offset. A pause may also have an expiry. Pilot
settings live in the service environment.

Run the signed local tests, then place a direct ingress call. After that,
call the clinic's regular line from a different phone and let it ring out.
Confirm the call reaches the intended agent, the right workspace inbox
receives the event, and the callback number survives both carrier legs.
Test the fallback and revert the carrier rule using its documented
procedure if the pilot path fails.

Staff actions are append-only and tenant-scoped in `clinic_followup_actions`.
The current state comes from the invoker-security `clinic_followup_states`
view. Marking a booking request handled records staff follow-up, not a
confirmed appointment or paid visit.

### Clinic Messenger pilot

The existing Eden Page continues to use its own reply flow. Clinic Pages use the
same signed webhook with a separate, opt-in Page-to-location mapping.

1. In Clinic Workspace, a location owner or admin requests **Facebook Messenger**.
2. A person authorized to manage messages for the Facebook Page grants the Meta
   app access and subscribes it to the Page's `messages` webhook field. Add the
   Meta app ID as `META_APP_ID` and store the Page configuration below as the
   Render secret `CLINIC_MESSENGER_PAGES`. Keep the Page token in Render.
3. An operator calls `POST /ops/messenger-connections` using the existing
   operations bearer credential with a JSON body of `{"pageId":"PAGE_ID"}`.
   The backend checks the token's Page identity, the app's Page subscription,
   and the workspace request. The connection moves to **Verifying**.
4. From an authorized tester account, send one fictional private message to the
   clinic Page. The connection moves to **Connected** after Meta accepts the
   reply. Try a booking request and a human handoff and check both in the
   location's **Needs attention** queue.

The Render JSON value is keyed by Page ID:

```json
{
  "1234567890": {
    "accountId": "ACCOUNT_UUID",
    "locationId": "LOCATION_UUID",
    "pageToken": "PAGE_ACCESS_TOKEN",
    "clinicName": "APPROVED_CLINIC_NAME",
    "facts": "Approved services, hours, pricing and booking instructions."
  }
}
```

A booking request awaits staff confirmation. An open booking or staff handoff
pauses automated replies on that conversation. Staff reply through the clinic's
Page inbox and can mark the item handled or booked in Clinic Workspace. The
pilot never retries an ambiguous outbound send. A staff item is created if the
send failed or a retry finds an interrupted send. Attachments are handed to
staff. Public comments and self-serve Facebook authorization are outside this
pilot. Keep one Render instance during the pilot because ordering within a
conversation is local to the instance.

### Guided Messenger setup for pilot locations

Apply `sql/clinic-messenger-facts.sql` before setting
`CLINIC_MESSENGER_GUIDED_SETUP=true`. The guide is available to owners and admins
of locations in the browser Messenger pilot. Confirmed location facts take
priority over the existing pilot text. The setup test uses a short-lived signed
message and creates a fictional, claimable Workspace item after Meta accepts
the reply. It skips staff email and runs in a separate test conversation state.
The regular Messenger flow remains available when the guide flag is off.

### One-post Facebook comment pilot

Set the optional `CLINIC_COMMENT_PILOT` value to a JSON object with `pageId`
and `postId`. Use the connected clinic Page ID and the selected post's full
Graph ID, in `PAGE_ID_POST_ID` format. Enable the Page `feed` webhook for this
pilot Page alongside `messages`. Begin with a fresh top-level test comment
from a separate Facebook account. Leave the setting empty to disable intake.

The clinic workspace's Activity inbox shows short review drafts. Staff can
open the original comment and post in Facebook. To allow clinic owners and
admins to review the original, edit the draft, and publish from the workspace,
add `"publish":true` to `CLINIC_COMMENT_PILOT`. Confirm that the connected Page
token can read the comment and publish replies with `pages_manage_engagement`
in a controlled test. Keep the tracking code in the posted reply for attribution.
Eden does not store the original comment or comment author. Eden claims each
draft once before publishing and records the reviewer and approved reply.
If the publish result is uncertain, inspect the thread in Facebook before
replying again. The workspace does not retry an uncertain publish.

The pilot counts tagged Messenger conversations, booking requests, and
appointments staff mark booked in the latest 100 location inbox items. A
conversation counts when a visitor sends the matching code. A booking in that
thread can retain the source for seven days. Untagged messages and visits from
a click-to-Messenger ad are outside this count. Use a fresh test thread or
finish any open staff case before running the tracked test.
