# Clinic self-serve: working product contract

This is the next build target after the Eden Page and two demo clinics. It is
intentionally a staged contract, not a claim that public onboarding is live.

## One account, many locations

A business account owns locations. A location has its own hours, services,
assistant instructions, staff alert destination, and channel connections.
Owners and admins can configure locations; staff can see the inbox and booking
queue for locations they are assigned to. An account may begin with one dental
clinic and later contain multiple branches or hospital departments. The first
API slice currently grants members account-wide reads; location-specific staff
assignments are a later access-control gate.

## Clinic setup in the product

1. Sign in, create the business account and first location.
2. Enter clinic facts: service names, hours, location, contact rules, language,
   emergency handoff instruction, and who receives staff alerts.
3. Test the receptionist in a private sandbox with sample patient questions.
4. Activate the website channel with a short embed snippet or hosted booking
   link. Connection status becomes `connected` only after a verified event.
5. Authorize the Facebook Page through the provider flow and set phone
   forwarding separately. Show `requested`, `verifying`, `connected`, or
   `action_required` per channel. Never present a request as a live connection.
6. Show all incoming inquiries, booking requests, cancellations, and human
   handoffs in one account-scoped inbox. Staff confirmation can change booking
   state; an AI promise alone cannot.

No clinic should copy data into a Sheet or install a binary. The website option
can be an embed or a link; Page permission and phone forwarding still require
an authorized action by the business.

## Outcome and billing definitions

| Event | Source of truth | Billing use |
| --- | --- | --- |
| Inquiry received | Signed channel webhook or hosted chat | Operational count. Exclude spam, tests, echoes, and duplicate deliveries. |
| Conversation processed | One deduplicated patient conversation in a defined inactivity window | Candidate usage unit, after a predictable monthly allowance. |
| Booking requested | Patient details and preferred time captured | Show in inbox; pending clinic confirmation. |
| Booking confirmed | Connected calendar or authorized staff action | Outcome measure; not inferred from assistant wording. |
| Attended or paid visit | Connected clinic system or payment confirmation | Outcome measure only when verified. |

Start with a predictable monthly plan and an included conversation allowance;
measure actual costs and disputes in pilots before setting a price or overage.
Voice minutes and outbound SMS need separate allowances. Revenue share remains
possible for bespoke pilots where attribution is agreed, not the default
self-serve contract. This is a product proposal, not a published price list.

## Release gates

- The tenant API and database policies are tested against a real Supabase
  project with two unrelated accounts: one must never read the other's data.
- A durable conversation inbox replaces process-memory Messenger deduplication
  and patient booking sessions before multi-instance operation.
- Website, Page, and phone connection flows verify ownership and store/rotate
  channel credentials outside user-visible records.
- Staff notification delivery is retried by a scheduled worker and visible as
  sent, pending, or failed; an owner can change a verified alert destination.
- Patient data retention and access controls are decided for each market before
  real clinics are invited.
- A clinic-facing inbox UI and a safe staff confirmation action are tested with
  one location, then multiple locations and staff roles.

The current tenant API and schema implement only the account/location skeleton,
connection requests, scoped reads, and server-to-server form events from a
previously connected website channel. Other channels remain on Eden's pilot
path until their tenant routing is built and authorized.
