# Live two-account isolation gate

This gate uses the running API and real Supabase Auth/RLS. The existing unit tests
mock the database; they do not prove the tenant boundary.

1. Apply `sql/clinic-outcomes.sql`, then `sql/clinic-tenancy.sql` in a disposable
   Supabase project. Deploy the backend with `SUPABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` set. The public key is
   safe for browser clients; the secret key stays only in the backend and this
   local test process.
2. Create two separate disposable Supabase Auth users, sign each in, and obtain
   their access JWTs. They must have no shared clinic membership. Configure the
   project Auth redirect allowlist for the `/clinic/` URL before testing email
   sign-in from the frontend.
3. Set these variables in your local shell or CI secret store without pasting
   their values into a chat, commit, or issue:

   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
   - `CLINIC_TEST_TOKEN_A`, `CLINIC_TEST_TOKEN_B`
   - `CLINIC_TEST_API_BASE` (the deployed API origin, without trailing slash)

4. Run `node scripts/two-account-isolation.mjs` before inviting clinics.

The runner creates disposable accounts and synthetic bookings, checks each user's
own records are present and the other user's account, locations, inbox, bookings,
and channel requests are absent, then tries an unauthorized location write. It
deletes synthetic events and accounts in `finally`; investigate any cleanup
warning. Never run it with patient data or a staff account.

The `/clinic/public-config` route exposes only Supabase's project URL and
publishable key. It returns nulls until configured. A rendered onboarding page
does not mean live channel connections, staff alerts, or booking confirmation
have been implemented.
