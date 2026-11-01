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
