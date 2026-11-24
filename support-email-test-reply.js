const { draftEdenSupportEmail } = require("./eden-support-email");

function mailbox(value) {
  return (typeof value === "string" ? value.match(/<([^<>]+)>\s*$/)?.[1] || value : "")
    .trim().toLowerCase();
}

const emailAddress = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;
const messageId = /^<[^<>\s]{1,998}>$/;

async function sendSupportTestReply({ configuration, receivingAddress, apiKey, fetchImpl = fetch, now = Date.now() }) {
  if (!configuration) return "disabled";
  let pilot;
  try { pilot = JSON.parse(configuration); }
  catch { return "invalid_configuration"; }
  if (!pilot || !apiKey || !receivingAddress ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(pilot.id || "") ||
      !emailAddress.test(pilot.to || "") || !emailAddress.test(pilot.from || "") ||
      !Number.isFinite(pilot.expiresAt) || pilot.expiresAt <= now ||
      pilot.expiresAt - now > 60 * 60 * 1000) return "invalid_or_expired_configuration";

  const forwarded = pilot.forwarded;
  if (forwarded !== undefined && (!forwarded ||
      typeof forwarded.teamAddress !== "string" || !emailAddress.test(forwarded.teamAddress) ||
      typeof forwarded.originalMessageId !== "string" || !messageId.test(forwarded.originalMessageId) ||
      typeof forwarded.originalSubject !== "string" || !forwarded.originalSubject.trim() ||
      /[\r\n]/.test(forwarded.originalSubject))) return "invalid_forwarded_configuration";

  const auth = {Authorization:"Bearer " + apiKey};
  const email = await fetchImpl("https://api.resend.com/emails/receiving/" + pilot.id, {
    headers:auth, signal:AbortSignal.timeout(10000)
  });
  if (!email.ok) return "read_failed_" + email.status;
  const original = await email.json();
  if (mailbox(original.from) !== mailbox(forwarded?.teamAddress ?? pilot.to) ||
      !Array.isArray(original.to) || !original.to.some(to=>mailbox(to)===mailbox(receivingAddress)) ||
      typeof original.message_id !== "string" || !messageId.test(original.message_id) ||
      typeof original.subject !== "string" || !original.subject.trim() || /[\r\n]/.test(original.subject) ||
      (forwarded && (original.subject.replace(/^fwd?:\s*/i, "") !== forwarded.originalSubject ||
        original.subject === forwarded.originalSubject ||
        original.message_id === forwarded.originalMessageId))) {
    return "original_message_not_matched";
  }
  const reply = draftEdenSupportEmail(original.text);
  if (reply.decision !== "draft") return "human_review";
  const threadMessageId = forwarded?.originalMessageId ?? original.message_id;
  const subject = forwarded?.originalSubject ?? original.subject;
  const response = await fetchImpl("https://api.resend.com/emails", {
    method:"POST", signal:AbortSignal.timeout(10000),
    headers:{...auth,"Content-Type":"application/json","Idempotency-Key":"eden-support-test/" + pilot.id},
    body:JSON.stringify({
      from:"Eden <" + mailbox(pilot.from) + ">",
      to:[mailbox(pilot.to)],
      subject:/^re:/i.test(subject) ? subject : "Re: " + subject,
      text:reply.body,
      ...(forwarded && {reply_to:mailbox(forwarded.teamAddress)}),
      headers:{"In-Reply-To":threadMessageId, References:threadMessageId, "Auto-Submitted":"auto-replied"}
    })
  });
  return response.ok ? "accepted_by_resend" : "send_failed_" + response.status;
}
module.exports = { sendSupportTestReply };
