const { draftEdenSupportEmail } = require("./eden-support-email");

function mailbox(value) {
  return (typeof value === "string" ? value.match(/<([^<>]+)>\s*$/)?.[1] || value : "")
    .trim().toLowerCase();
}

async function sendSupportTestReply({ configuration, receivingAddress, apiKey, fetchImpl = fetch, now = Date.now() }) {
  if (!configuration) return "disabled";
  let pilot;
  try { pilot = JSON.parse(configuration); }
  catch { return "invalid_configuration"; }
  if (!pilot || !apiKey || !receivingAddress ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(pilot.id || "") ||
      !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(pilot.to || "") ||
      !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(pilot.from || "") ||
      !Number.isFinite(pilot.expiresAt) || pilot.expiresAt <= now ||
      pilot.expiresAt - now > 60 * 60 * 1000) return "invalid_or_expired_configuration";

  const auth = {Authorization:"Bearer " + apiKey};
  const email = await fetchImpl("https://api.resend.com/emails/receiving/" + pilot.id, {
    headers:auth, signal:AbortSignal.timeout(10000)
  });
  if (!email.ok) return "read_failed_" + email.status;
  const original = await email.json();
  if (mailbox(original.from) !== mailbox(pilot.to) ||
      !Array.isArray(original.to) || !original.to.some(to=>mailbox(to)===mailbox(receivingAddress)) ||
      typeof original.message_id !== "string" || !/^<[^<>\s]{1,998}>$/.test(original.message_id) ||
      typeof original.subject !== "string" || !original.subject.trim() || /[\r\n]/.test(original.subject)) {
    return "original_message_not_matched";
  }
  const reply = draftEdenSupportEmail(original.text);
  if (reply.decision !== "draft") return "human_review";
  const response = await fetchImpl("https://api.resend.com/emails", {
    method:"POST", signal:AbortSignal.timeout(10000),
    headers:{...auth,"Content-Type":"application/json","Idempotency-Key":"eden-support-test/" + pilot.id},
    body:JSON.stringify({
      from:"Eden <" + mailbox(pilot.from) + ">",
      to:[mailbox(pilot.to)],
      subject:/^re:/i.test(original.subject) ? original.subject : "Re: " + original.subject,
      text:reply.body,
      headers:{"In-Reply-To":original.message_id, References:original.message_id, "Auto-Submitted":"auto-replied"}
    })
  });
  return response.ok ? "accepted_by_resend" : "send_failed_" + response.status;
}
module.exports = { sendSupportTestReply };
