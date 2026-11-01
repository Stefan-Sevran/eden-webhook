// A bounded, single-process idempotency guard for Meta's at-least-once delivery.
// A shared durable inbox is needed before running more than one web instance.
function createMessengerProcessor({ pageId, handleText, logger = console, now = Date.now }) {
  const completed = new Map();
  const inFlight = new Map();
  const conversationQueues = new Map();
  const retentionMs = 24 * 60 * 60 * 1000;
  const maxCompleted = 10000;

  function pruneCompleted() {
    const cutoff = now() - retentionMs;
    for (const [key, timestamp] of completed) {
      if (timestamp < cutoff) completed.delete(key);
    }
    while (completed.size > maxCompleted) {
      completed.delete(completed.keys().next().value);
    }
  }

  async function processPayload(payload) {
    if (payload?.object !== "page" || !Array.isArray(payload.entry)) {
      return { processed: 0, ignored: 0 };
    }

    pruneCompleted();
    const tasks = [];
    let ignored = 0;

    for (const entry of payload.entry) {
      const events = Array.isArray(entry.messaging) ? entry.messaging : [];
      if (String(entry.id) !== String(pageId)) {
        logger.warn("Ignoring Messenger event for unconfigured Page", { pageId: entry.id });
        ignored += events.length;
        continue;
      }

      for (const event of events) {
        const senderId = event?.sender?.id;
        const messageId = event?.message?.mid;
        const text = event?.message?.text;
        if (!senderId || !messageId || !text?.trim() || event.message.is_echo) {
          ignored++;
          continue;
        }

        const key = `${pageId}:${messageId}`;
        if (completed.has(key)) {
          ignored++;
          continue;
        }
        if (inFlight.has(key)) {
          tasks.push(inFlight.get(key));
          ignored++;
          continue;
        }

        const conversationKey = `${pageId}:${senderId}`;
        const previous = conversationQueues.get(conversationKey) || Promise.resolve();
        const task = previous.catch(() => {}).then(async () => {
          await handleText({ pageId, senderId, text, messageId });
          completed.set(key, now());
          pruneCompleted();
        });
        inFlight.set(key, task);
        conversationQueues.set(conversationKey, task);
        task.finally(() => {
          inFlight.delete(key);
          if (conversationQueues.get(conversationKey) === task) {
            conversationQueues.delete(conversationKey);
          }
        }).catch(() => {});
        tasks.push(task);
      }
    }

    const results = await Promise.allSettled(tasks);
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(failures.map(result => result.reason), "Messenger processing failed");
    }
    return { processed: new Set(tasks).size, ignored };
  }

  return { processPayload };
}

module.exports = { createMessengerProcessor };
