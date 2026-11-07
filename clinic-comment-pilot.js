const { outcomeKey } = require("./outcome-ledger");
const { isUuid } = require("./clinic-tenant");

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
  return { pageId: config.pageId, postId: config.postId, ...(config.publish === true ? { publish: true } : {}) };
}

function reviewError(status, message) {
  return Object.assign(new Error(message), { status });
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

function createCommentPilot({ config, getPage, ledger, recordOutcome, isAdmin, commentGraph, now = Date.now }) {
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

  async function reviewTarget(req, input) {
    if (!config?.publish) throw reviewError(403, "Comment publishing is disabled");
    const { accountId, locationId, eventKey } = input || {};
    if (!isUuid(accountId) || !isUuid(locationId) || !/^[a-f0-9]{64}$/.test(eventKey || "")) {
      throw reviewError(400, "Invalid comment review request");
    }
    const page = getPage(config.pageId);
    if (page?.accountId !== accountId || page.locationId !== locationId || !await isAdmin(req, accountId)) {
      throw reviewError(403, "Comment publishing requires an administrator for the pilot location");
    }
    const route = await ledger.messengerLocation(config.pageId, page);
    if (route?.status !== "connected") throw reviewError(409, "The pilot Page is disconnected");
    const draft = await ledger.commentDraftForReview(route, config.postId, eventKey);
    if (!draft || draft.details?.pageId !== config.pageId || !objectId.test(draft.details?.commentId || "")) {
      throw reviewError(404, "Comment draft not found");
    }
    if (draft.status !== "staff_review") throw reviewError(409, "The comment draft has already been processed");
    return { route, page, draft, commentId: draft.details.commentId };
  }

  async function loadOriginal({ page, route, commentId }) {
    const original = await commentGraph(config.pageId, page, route, commentId);
    if (String(original.id) !== commentId || original.is_hidden === true ||
        typeof original.message !== "string" || !original.message.trim()) {
      throw reviewError(409, "The Facebook comment is unavailable for review");
    }
    return { message: original.message, version: outcomeKey("comment_review", commentId, original.message) };
  }

  async function review(req) {
    return loadOriginal(await reviewTarget(req, req.query));
  }

  async function publish(req) {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message || message.length > 500 || !/^[a-f0-9]{64}$/.test(req.body?.version || "")) {
      throw reviewError(400, "A reviewed reply of 1 to 500 characters is required");
    }
    const target = await reviewTarget(req, req.body);
    const { route, page, draft, commentId } = target;
    if ((await loadOriginal(target)).version !== req.body.version) {
      throw reviewError(409, "The Facebook comment changed during review");
    }
    const transition = (expected, status, details) =>
      ledger.transitionCommentDraft(route, config.postId, draft.event_key, expected, status, details);
    const details = { ...draft.details, approvedReply: message, approvedBy: req.clinicUserId,
      approvedAt: new Date(now()).toISOString() };
    if (!await transition("staff_review", "publishing", details)) {
      throw reviewError(409, "Another reviewer already handled this comment");
    }

    let publishedId;
    try {
      const result = await commentGraph(config.pageId, page, route, commentId, message);
      if (objectId.test(result.id || "")) publishedId = result.id;
    } catch {
      // A timeout or lost response may follow a successful send. Never retry here.
    }
    const status = publishedId ? "published" : "publish_unverified";
    if (!await transition("publishing", status, { ...details, ...(publishedId ? { publishedId } : {}) })) {
      throw reviewError(409, "Check the comment on Facebook before taking further action");
    }
    return { status };
  }

  return { processPayload, messageContext, recordStarted, review, publish };
}

module.exports = { createCommentPilot, parseCommentPilot };
