import assert from "node:assert/strict";
import test from "node:test";

import {
  createWecomAgentDispatchState,
  resolveWecomAgentReplyRuntimePolicy,
} from "../src/wecom/agent-reply-runtime.js";

test("createWecomAgentDispatchState returns initialized mutable state", () => {
  const state = createWecomAgentDispatchState();
  assert.equal(state.hasDeliveredReply, false);
  assert.equal(state.hasDeliveredPartialReply, false);
  assert.equal(state.hasSentProgressNotice, false);
  assert.equal(state.blockTextFallback, "");
  assert.equal(state.streamChunkBuffer, "");
  assert.equal(state.streamChunkLastSentAt, 0);
  assert.equal(state.streamChunkSentCount, 0);
  assert.equal(typeof state.streamChunkSendChain?.then, "function");
  assert.equal(state.suppressLateDispatcherDeliveries, false);
});

test("resolveWecomAgentReplyRuntimePolicy reads cfg env values", () => {
  const policy = resolveWecomAgentReplyRuntimePolicy({
    cfg: {
      env: {
        vars: {
          WECOM_REPLY_TIMEOUT_MS: "30000",
          WECOM_PROGRESS_NOTICE_MS: "500",
          WECOM_LATE_REPLY_WATCH_MS: "120000",
          WECOM_LATE_REPLY_POLL_MS: "1500",
        },
      },
    },
    asNumber: (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    },
    requireEnv: () => undefined,
  });
  assert.deepEqual(policy, {
    replyTimeoutMs: 30000,
    progressNoticeDelayMs: 500,
    lateReplyWatchMs: 120000,
    lateReplyPollMs: 1500,
  });
});

test("resolveWecomAgentReplyRuntimePolicy applies bounds", () => {
  const policy = resolveWecomAgentReplyRuntimePolicy({
    cfg: { env: { vars: {} } },
    asNumber: (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    },
    requireEnv: () => undefined,
    defaultReplyTimeoutMs: 5000,
    defaultLateReplyWatchMs: 1000,
    defaultLateReplyPollMs: 100000,
  });
  assert.equal(policy.replyTimeoutMs, 15000);
  assert.equal(policy.progressNoticeDelayMs, 0);
  assert.equal(policy.lateReplyWatchMs, 30000);
  assert.equal(policy.lateReplyPollMs, 10000);
});
