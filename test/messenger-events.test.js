const assert = require("node:assert/strict");
const test = require("node:test");
const { createMessengerProcessor } = require("../messenger-events");

const pageId = "1086617101195136";
function payload(mid, text = "DEMO", senderId = "person-1") {
  return {
    object: "page",
    entry: [{ id: pageId, messaging: [{
      sender: { id: senderId },
      message: { mid, text }
    }] }]
  };
}

test("one Meta message triggers one reply even when delivered twice concurrently and later", async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const processor = createMessengerProcessor({
    pageId,
    async handleText(event) {
      calls.push(event);
      await gate;
    }
  });

  const first = processor.processPayload(payload("mid-1"));
  const retry = processor.processPayload(payload("mid-1"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  await Promise.all([first, retry]);
  await processor.processPayload(payload("mid-1"));
  assert.equal(calls.length, 1);
});

test("handles every entry and serializes different messages from one sender", async () => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const processor = createMessengerProcessor({
    pageId,
    async handleText({ text }) {
      order.push(`start:${text}`);
      if (text === "first") await gate;
      order.push(`end:${text}`);
    }
  });
  const input = {
    object: "page",
    entry: [
      ...payload("mid-1", "first").entry,
      ...payload("mid-2", "second").entry,
      { id: "another-page", messaging: payload("mid-3").entry[0].messaging }
    ]
  };
  const working = processor.processPayload(input);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["start:first"]);
  release();
  await working;
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
});

test("a failed send remains eligible for Meta's retry", async () => {
  let calls = 0;
  const processor = createMessengerProcessor({
    pageId,
    async handleText() {
      calls++;
      if (calls === 1) throw new Error("Graph send failed");
    }
  });
  await assert.rejects(processor.processPayload(payload("mid-1")));
  await processor.processPayload(payload("mid-1"));
  assert.equal(calls, 2);
});

test("ignores echoes and events without message text", async () => {
  let calls = 0;
  const processor = createMessengerProcessor({ pageId, async handleText() { calls++; } });
  const input = payload("mid-1");
  input.entry[0].messaging.push({ sender: { id: "person-1" }, message: { mid: "mid-2", text: "echo", is_echo: true } });
  input.entry[0].messaging.push({ sender: { id: "person-1" }, delivery: { mids: ["mid-3"] } });
  await processor.processPayload(input);
  assert.equal(calls, 1);
});
