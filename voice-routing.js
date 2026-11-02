const E164 = /^\+[1-9][0-9]{7,14}$/;
const AGENT_ID = /^agent_[a-zA-Z0-9_-]{8,100}$/;

function voiceIdentity(data) {
  const phone = data?.metadata?.phone_call;
  const variables = data?.conversation_initiation_client_data?.dynamic_variables;
  const calledNumber = phone?.agent_number || variables?.system__called_number;
  const caller = phone?.external_number || variables?.system__caller_id;
  if (!AGENT_ID.test(data?.agent_id || "") || !E164.test(calledNumber || "") ||
      typeof data?.conversation_id !== "string" || !/^[a-zA-Z0-9_-]{4,120}$/.test(data.conversation_id)) {
    return null;
  }
  if (phone && phone.direction !== "inbound") return null;
  return { agentId: data.agent_id, calledNumber, conversationId: data.conversation_id,
    caller: E164.test(caller || "") ? caller : null };
}

module.exports = { E164, AGENT_ID, voiceIdentity };
