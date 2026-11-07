const { outcomeKey } = require("./outcome-ledger");

const day = 24 * 60 * 60 * 1000;
const number = /^\d{5,30}$/;
const objectId = /^\d{5,30}(?:_\d{5,30})?$/;
const trackingCode = /\bEDEN-[A-F0-9]{10}\b/i;

function parseCommentPilot(raw) {
  if (!raw) return null;
  const config = JSON.parse(raw);
  if (!config || typeof config.pageId !== "string" || !number.test(config.pageId) ||
      typeof config.postId !== "string" || !objectId.test(config.postId) ||
      !config.postId.startsWith(config.pageId + "_")) {
    throw Error("Expected one Page ID and its full Page post ID");
  }
  return { pageId: config.pageId, postId: config.postId };
}

function publicDraft(text, code) {
  const topics = [
    [/\b(price|prices|cost|fees?|how much|magkano|tagpila|pila)\b/i, "we can help with your pricing question"],
    [/\b(where|location|address|branch|asa|saan)\b/i, "we can help you find the clinic"],
    [/\b(open|hours|closing)\b/i, "we can confirm the clinic hours"],
    [/\b(book|booking|appointment|slots?|available|schedule)\b/i, "we can help you request a visit"]
  ];
  const topic = topics.find(([pattern]) => pattern.test(text));
  const action = topic?.[1] || "our clinic team can help";
  return `Thanks for reaching out! Tap Message on our Page and include ${code} so ${action}.`;
}

function createCommentPilot({ config, getPage, ledger, recordOutcome, now = Date.now }) {
  async function processPayload(payload) {
    if (!config || payload?.object !== "page" || !Array.isArray(payload.entry)) return;
    const { pageId, postId } = config;
    const storyId = postId.split("_")[1];
    const comments = new Map();
    const currentTime = now();
    for (const entry of payload.entry) {
      if (String(entry?.id) !== pageId || !Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        const value = change?.value;
        const parent = String(value?.parent_id || "");
        const author = String(value?.from?.id || value?.sender_id || "");
        if (change?.field !== "feed" || value?.item !== "comment" || value.verb !== "add" ||
            value.post_id !== postId || (parent !== postId && parent !== storyId) || value.is_hidden === true ||
            typeof value.comment_id !== "string" || !objectId.test(value.comment_id) ||
            !number.test(author) || author === pageId ||
            typeof value.message !== "string" || !value.message.trim()) continue;
        const created = Number(value.created_time) * 1000;
        if (!Number.isFinite(created) || created <= currentTime - day || created > currentTime + 60000) continue;
        comments.set(value.comment_id, value.message);
      }
    }
    if (!comments.size) return;
    const page = getPage(pageId);
    if (!page) return;
    const route = await ledger.messengerLocation(pageId, page);
    if (route?.status !== "connected") return;

    for (const [commentId, text] of comments) {
      const eventKey = outcomeKey("clinic_comment_draft", route.account_id, route.location_id, pageId, postId, commentId);
      const code = "EDEN-" + eventKey.slice(0, 10).toUpperCase();
      await recordOutcome({
        event_key: eventKey, clinic_id: route.location_id, account_id: route.account_id, location_id: route.location_id,
        channel: "facebook_comment", kind: "comment.draft", status: "staff_review",
        summary: "Facebook comment reply draft",
        details: { pageId, commentId, commentPilotPostId: postId, commentPilotCode: code, publicDraft: publicDraft(text, code) }
      });
    }
  }

  async function messageContext({ pageId, route, text, received, previousSource }) {
    if (config?.pageId !== pageId || route.status !== "connected") return { text };
    const postId = config.postId;
    const match = text.match(trackingCode);
    if (match) {
      const code = match[0].toUpperCase();
      if (await ledger.commentDraft(route, postId, code, new Date(received - 7 * day).toISOString())) {
        return { text: text.replace(trackingCode, "").trim(), source: { postId, code, received } };
      }
    }
    const source = previousSource?.postId === postId && received >= previousSource.received &&
      received - previousSource.received < 7 * day ? previousSource : undefined;
    return { text, source };
  }

  async function recordStarted(route, conversationKey, source) {
    await recordOutcome({
      event_key: outcomeKey("clinic_comment_messenger_started", conversationKey, source.postId),
      clinic_id: route.location_id, account_id: route.account_id, location_id: route.location_id,
      channel: "facebook_messenger", kind: "comment.messenger_started", status: "received",
      summary: "Messenger conversation from a Facebook comment reply",
      details: { commentPilotPostId: source.postId, commentPilotCode: source.code }
    });
  }

  return { processPayload, messageContext, recordStarted };
}

module.exports = { createCommentPilot, parseCommentPilot };
