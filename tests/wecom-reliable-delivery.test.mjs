import assert from "node:assert/strict";
import test from "node:test";

import {
  createWecomReliableDeliveryStore,
  inferWecomDeliveryStatus,
  resolveWecomReplyWindowState,
  WECOM_REPLY_WINDOW_MS,
} from "../src/wecom/reliable-delivery.js";
import { createWecomPendingReplyManager } from "../src/wecom/pending-reply-manager.js";

test("reliable delivery store tracks inbound window and delivery outcomes", () => {
  let now = 1_700_000_000_000;
  const store = createWecomReliableDeliveryStore({
    now: () => now,
  });

  store.markInboundActivity({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:dingxiang",
    fromUser: "dingxiang",
  });
  let snapshot = store.getDeliverySnapshot({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:dingxiang",
  });
  assert.equal(snapshot.account.replyWindowState, "reply_window_open");
  assert.equal(snapshot.session.replyWindowState, "reply_window_open");

  now += WECOM_REPLY_WINDOW_MS + 1000;
  snapshot = store.getDeliverySnapshot({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:dingxiang",
  });
  assert.equal(snapshot.session.replyWindowState, "reply_window_expired");

  store.recordDeliveryOutcome({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:dingxiang",
    fromUser: "dingxiang",
    deliveryStatus: "delivered",
    layer: "agent_push",
    reason: "pending-reply",
  });
  snapshot = store.getDeliverySnapshot({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:dingxiang",
  });
  assert.equal(snapshot.account.proactiveQuotaState, "proactive_quota_available");
  assert.equal(snapshot.session.lastDeliveryStatus, "delivered");
});

test("reliable delivery store dedupes and reschedules pending replies", () => {
  let now = 1_700_000_000_000;
  const store = createWecomReliableDeliveryStore({
    now: () => now,
  });

  const first = store.enqueuePendingReply({
    mode: "bot",
    accountId: "default",
    sessionId: "wecom-bot:dingxiang",
    fromUser: "dingxiang",
    payload: {
      text: "hello",
    },
    reason: "fetch failed",
    deliveryStatus: "rejected_transport",
    retryBackoffMs: 2000,
    maxRetries: 2,
  });
  const second = store.enqueuePendingReply({
    mode: "bot",
    accountId: "default",
    sessionId: "wecom-bot:dingxiang",
    fromUser: "dingxiang",
    payload: {
      text: "hello",
    },
    reason: "fetch failed",
    deliveryStatus: "rejected_transport",
    retryBackoffMs: 2000,
    maxRetries: 2,
  });
  assert.equal(Boolean(first?.enqueued), true);
  assert.equal(Boolean(second?.enqueued), false);

  now += 2500;
  const due = store.listDuePendingReplies({ at: now });
  assert.equal(due.length, 1);

  const rescheduled = store.reschedulePendingReply({
    id: first.id,
    reason: "fetch failed again",
    at: now,
  });
  assert.equal(rescheduled.rescheduled, true);

  now += 5000;
  const later = store.listDuePendingReplies({ at: now });
  assert.equal(later.length, 1);
  assert.equal(later[0].retryCount, 1);
});

test("reliable delivery store exports and hydrates durable state", () => {
  let now = 1_700_000_000_000;
  const store = createWecomReliableDeliveryStore({
    now: () => now,
  });

  store.markInboundActivity({
    mode: "bot",
    accountId: "default",
    sessionId: "wecom-bot:alice",
    fromUser: "alice",
  });
  const queued = store.enqueuePendingReply({
    mode: "bot",
    accountId: "default",
    sessionId: "wecom-bot:alice",
    fromUser: "alice",
    payload: {
      text: "待补发",
      thinkingContent: "先想",
      mediaUrls: ["https://example.com/a.png"],
    },
    reason: "fetch failed",
    deliveryStatus: "rejected_transport",
    retryBackoffMs: 3000,
    maxRetries: 3,
  });
  assert.ok(queued?.id);

  const snapshot = store.exportState({ at: now });
  const restored = createWecomReliableDeliveryStore({
    now: () => now,
  });
  restored.hydrateState(snapshot, { at: now });

  const restoredSnapshot = restored.getDeliverySnapshot({
    mode: "bot",
    accountId: "default",
    sessionId: "wecom-bot:alice",
  });
  assert.equal(restoredSnapshot.account.pendingCount, 1);
  assert.equal(restoredSnapshot.session.pendingCount, 1);
  const pending = restored.listPendingRepliesForSession({
    mode: "bot",
    accountId: "default",
    sessionId: "wecom-bot:alice",
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.thinkingContent, "先想");
  assert.deepEqual(pending[0].payload.mediaUrls, ["https://example.com/a.png"]);
  assert.equal(restored.countPendingReplies(), 1);
});

test("pending reply manager retries and settles delivered entries", async () => {
  let now = 1_700_000_000_000;
  const store = createWecomReliableDeliveryStore({
    now: () => now,
  });
  const attempts = [];
  const manager = createWecomPendingReplyManager({
    reliableDeliveryStore: store,
    resolveWecomPendingReplyPolicy: () => ({
      enabled: true,
      maxRetries: 3,
      retryBackoffMs: 1000,
      expireMs: 10000,
    }),
    deliverPendingReply: async (entry) => {
      attempts.push(entry.id);
      return {
        ok: true,
        deliveryStatus: "delivered",
      };
    },
    now: () => now,
    sweepIntervalMs: 10000,
  });

  const entry = manager.enqueuePendingReply(
    { logger: { warn() {} } },
    {
      mode: "agent",
      accountId: "default",
      sessionId: "wecom:dingxiang",
      fromUser: "dingxiang",
      payload: {
        text: "hello",
      },
      reason: "fetch failed",
      deliveryStatus: "rejected_transport",
    },
  );
  assert.ok(entry?.id);

  now += 1500;
  await manager.flushDuePendingReplies("test");
  assert.equal(attempts.length, 1);
  const pending = store.listPendingRepliesForSession({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:dingxiang",
  });
  assert.equal(pending.length, 0);
});

test("delivery helpers classify transport and window failures", () => {
  assert.equal(inferWecomDeliveryStatus({ reason: "fetch failed", layer: "agent_push" }), "rejected_transport");
  assert.equal(inferWecomDeliveryStatus({ reason: "outside response window", layer: "response_url" }), "rejected_window");
  assert.equal(resolveWecomReplyWindowState(Date.now() - 1000), "reply_window_open");
});
