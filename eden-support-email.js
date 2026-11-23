/* Drafts for routine Clinic Workspace questions. Routing and delivery live outside this module. */
function draftEdenSupportEmail(body) {
  const message = String(body ?? '').trim();
  if (!message || message.length > 4000 || /\b(?:patient|diagnos\w*|prescri\w*|medical|privacy|breach|refund|invoice|payment|billing|abuse|compromised|password|credentials?|api key)\b|\b\d{6,}\b/i.test(message)) {
    return {decision:'human'};
  }
  const guides = [
    [/rate limit|too many.*(?:email|code)/i, 'If you have an unused sign-in link from this workspace, open it. Otherwise, wait before requesting another email.'],
    [/\b(support request|access request|(?:find|see|approve) the request|request.*access)\b/i,
      'Select the clinic location the request was sent to. The clinic owner can open Alerts and choose the Eden support request.'],
    [/\b(sign[ -]?in|log[ -]?in|login|magic link)\b/i,
      'Open your Clinic Workspace and request a fresh sign-in email. Open the link in that email in the same browser profile.'],
    [/\b(?:messenger|website chat|ai phone)\b.*\b(?:connection|connect\w*|status|set up|setup)\b|\b(?:connection|connect\w*|status|set up|setup)\b.*\b(?:messenger|website chat|ai phone)\b/i,
      'Open Connect in your Clinic Workspace and select the channel. The connection card shows its current status and next step.']
  ];
  const guide = guides.find(([pattern])=>pattern.test(message));
  if (!guide) return {decision:'human'};
  return {decision:'draft',body:
    'Hi, I’m Eden, ClinicNet’s AI support assistant.\n\n'+guide[1]+
    '\n\nIf that doesn’t solve it, reply with the step where you got stuck and our support team can take a look.'};
}
if (typeof module === 'object' && module.exports) module.exports = {draftEdenSupportEmail};
