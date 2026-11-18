# Revenue Rescue pilot

In Daily Action, a clinic owner or admin opens Revenue Rescue Reports and records the agreed start date, currency, rate and reporting cadence. The first seven clinic-local calendar days are free. The suggested rate is 15%. Saving the pilot fixes these terms for that location. Weekly, fortnightly and monthly results are available, starting with a seven-day pilot report. Settlements close by calendar month.

Staff record a completed visit on a confirmed appointment, or choose Completed walk-in under Add booking. Blank means the amount is pending. Zero means the clinic recorded no collection. Enter the cumulative amount collected and an optional receipt reference. A correction or refund creates a new entry for the difference. Link a walk-in to its original Eden request to attribute it. A request can back one completed visit. Staff-entered visits without a link remain clinic activity.

The report counts recorded events. The fee uses collections in the agreed currency where both the original request and visit occurred after the free week. Late entries and corrections appear in their posting period. Monthly credits offset future shares, using cumulative currency rounding. Clinic staff can check references before an owner approves. Final refunds or disputed adjustments can be reconciled against the receipt history. Reports cannot establish that a patient would otherwise have gone elsewhere.

The webhook checks for closed periods every 15 minutes and catches up when it restarts. Opening Reports also generates missing drafts. Email is opt-in to a verified manager's own address. Approval queues one private Workspace link. Delivery uses the existing Resend sender, a report-specific idempotency key, expiring leases and bounded retries. Reports remain in Workspace during email outages. No mail is generated for a location without a reporting configuration.

For an approved positive monthly settlement, create an amount-specific checkout using Eden's merchant account. Run this command in the configured webhook environment, substituting the report details and the actual provider URL:

    node scripts/attach-rescue-checkout.mjs REPORT_UUID PHP 1500.00 HTTPS_CHECKOUT_URL

The command checks the approved amount and currency. The Workspace renders the same URL as a button and a locally generated QR code. The payment provider records payment. Attaching a link or approving a report does not collect funds.
