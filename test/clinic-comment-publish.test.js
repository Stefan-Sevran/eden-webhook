const test = require("node:test");
const assert = require("node:assert/strict");
const { createCommentPilot, parseCommentPilot } = require("../clinic-comment-pilot");
const { createClinicMessenger } = require("../clinic-messenger");
const { createOutcomeLedger } = require("../outcome-ledger");

const pageId = "1142491848941366", postId = pageId + "_122093069769314755";
const commentId = "122093069769314755_123456789", eventKey = "a".repeat(64);
const accountId = "9e939ec0-b740-448e-8a92-886548e922e2", locationId = "e2395766-3859-4c89-b452-6f3a7a9f9422";
const actor = "605e1888-18bf-4c30-8521-a35a7e0d1e78";
const target = { accountId, locationId, eventKey };
const req = { query: target, clinicUserId: actor };

function fixture({ enabled = true, admin = true } = {}) {
  let draft = { event_key: eventKey, status: "staff_review", details: { pageId, commentId, commentPilotPostId: postId } };
  let original = "Are there appointments next week?", fail = false;
  const sent = [];
  const ledger = createOutcomeLedger({ url: "https://db.example", key: "test-server-key",
    async fetchImpl(url, options) {
      const { pathname, searchParams } = new URL(url);
      if (pathname.endsWith("/clinic_channel_connections")) {
        return Response.json([{ id: "connected-route", account_id: accountId, location_id: locationId, status: "connected" }]);
      }
      if (pathname.endsWith("/clinic_locations")) return Response.json([{ alert_email: null }]);
      assert.ok(pathname.endsWith("/clinic_outcomes"));
      for (const [field, value] of Object.entries({ account_id: accountId, location_id: locationId,
        channel: "facebook_comment", kind: "comment.draft", "details->>commentPilotPostId": postId, event_key: eventKey })) {
        assert.equal(searchParams.get(field), "eq." + value);
      }
      if (options.method !== "PATCH") return Response.json([draft]);
      if (searchParams.get("status") !== "eq." + draft.status) return Response.json([]);
      draft = { ...draft, ...JSON.parse(options.body) };
      return Response.json([{ event_key: eventKey }]);
    }
  });
  const messenger = createClinicMessenger({ pages: new Map(), appSecret: "test-app-secret",
    getStoredPageToken: async (id, route) => {
      assert.equal(id, pageId);
      assert.equal(route.location_id, locationId);
      return "test-page-token";
    },
    async fetchImpl(url, options) {
      const graph = new URL(url);
      assert.ok(graph.searchParams.has("appsecret_proof"));
      assert.equal(options.headers.Authorization, "Bearer test-page-token");
      if (options.method === "GET") {
        assert.ok(graph.pathname.endsWith("/" + commentId));
        return Response.json({ id: commentId, message: original });
      }
      assert.equal(draft.status, "publishing");
      assert.ok(graph.pathname.endsWith("/" + commentId + "/comments"));
      sent.push(JSON.parse(options.body).message);
      if (fail) throw new Error("Lost response");
      return Response.json({ id: "123456789_987654321" });
    }
  });
  const pilot = createCommentPilot({ config: parseCommentPilot(JSON.stringify({ pageId, postId, publish: enabled })),
    getPage: () => ({ accountId, locationId }), ledger, isAdmin: async () => admin, commentGraph: messenger.commentGraph });
  return { pilot, sent, getDraft: () => draft, edit: () => { original = "I need a different date"; }, fail: () => { fail = true; } };
}

test("one scoped owner approval publishes the edited reply even with concurrent submissions", async () => {
  const { pilot, sent, getDraft } = fixture();
  const review = await pilot.review(req);
  assert.match(review.message, /appointments/);
  const body = { ...target, message: "Please message our Page for availability.", version: review.version };
  const results = await Promise.allSettled([pilot.publish({ ...req, body }), pilot.publish({ ...req, body })]);
  assert.deepEqual(results.filter(result => result.status === "fulfilled").map(result => result.value), [{ status: "published" }]);
  assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
  assert.deepEqual(sent, [body.message]);
  assert.equal(getDraft().details.approvedBy, actor);
  assert.equal(getDraft().details.approvedReply, body.message);
  assert.ok(!JSON.stringify(getDraft()).includes(review.message));
});

test("disabled, foreign, unapproved, and stale reviews cannot publish, and uncertain sends are never retried", async () => {
  await assert.rejects(fixture({ enabled: false }).pilot.review(req), { status: 403 });
  await assert.rejects(fixture({ admin: false }).pilot.review(req), { status: 403 });
  const { pilot, sent, getDraft, edit, fail } = fixture();
  await assert.rejects(pilot.review({ ...req, query: { ...target, accountId: actor } }), { status: 403 });
  const review = await pilot.review(req);
  const body = { ...target, message: "Please message us to book.", version: review.version };
  edit();
  await assert.rejects(pilot.publish({ ...req, body }), { status: 409 });
  assert.equal(sent.length, 0);
  const current = await pilot.review(req);
  const approved = { ...req, body: { ...body, version: current.version } };
  fail();
  assert.deepEqual(await pilot.publish(approved), { status: "publish_unverified" });
  assert.equal(getDraft().status, "publish_unverified");
  await assert.rejects(pilot.publish(approved), { status: 409 });
  assert.equal(sent.length, 1);
});
