import assert from "node:assert/strict";
import test from "node:test";

import { handleWecomBotDispatchError, handleWecomBotPostDispatchFallback } from "../src/wecom/bot-dispatch-fallback.js";

test("handleWecomBotPostDispatchFallback sends block fallback text", async () => {
  const calls = [];
  const shouldReturn = await handleWecomBotPostDispatchFallback({
    api: { logger: { warn() {} } },
    sessionId: "wecom-bot:u1",
    dispatchState: { streamFinished: false, blockText: "hello block" },
    dispatchStartedAt: 1000,
    tryFinishFromTranscript: async () => false,
    markdownToWecomText: (text) => String(text),
    safeDeliverReply: async (text, reason) => {
      calls.push({ text, reason });
      return true;
    },
    startLateReplyWatcher: () => false,
  });
  assert.equal(shouldReturn, false);
  assert.deepEqual(calls, [{ text: { text: "hello block", thinkingContent: "" }, reason: "block-fallback" }]);
});

test("handleWecomBotPostDispatchFallback preserves thinkingContent", async () => {
  const calls = [];
  const shouldReturn = await handleWecomBotPostDispatchFallback({
    api: { logger: { warn() {} } },
    sessionId: "wecom-bot:u2",
    dispatchState: { streamFinished: false, blockText: "<think>先想想</think>给答案" },
    dispatchStartedAt: 1000,
    tryFinishFromTranscript: async () => false,
    markdownToWecomText: (text) => String(text),
    safeDeliverReply: async (payload, reason) => {
      calls.push({ payload, reason });
      return true;
    },
    startLateReplyWatcher: () => false,
  });
  assert.equal(shouldReturn, false);
  assert.deepEqual(calls, [{ payload: { text: "给答案", thinkingContent: "先想想" }, reason: "block-fallback" }]);
});

test("handleWecomBotPostDispatchFallback starts watcher when no deliverable text", async () => {
  const shouldReturn = await handleWecomBotPostDispatchFallback({
    api: { logger: { warn() {} } },
    sessionId: "wecom-bot:u1",
    dispatchState: { streamFinished: false, blockText: "" },
    dispatchStartedAt: 1000,
    tryFinishFromTranscript: async () => false,
    markdownToWecomText: (text) => String(text),
    safeDeliverReply: async () => true,
    startLateReplyWatcher: () => true,
  });
  assert.equal(shouldReturn, true);
});

test("handleWecomBotDispatchError returns early when timeout watcher started", async () => {
  const result = await handleWecomBotDispatchError({
    api: { logger: { warn() {} } },
    err: new Error("dispatch timed out after 90000ms"),
    dispatchStartedAt: 1000,
    isDispatchTimeoutError: () => true,
    startLateReplyWatcher: () => true,
    sessionId: "wecom-bot:u1",
    fromUser: "u1",
    buildWecomBotSessionId: (u) => `wecom-bot:${u}`,
    runtime: { channel: { session: { resolveStorePath: () => "/tmp/store" } } },
    cfg: {},
    routedAgentId: "main",
    readTranscriptFallbackResult: async () => ({ text: "", transcriptMessageId: "" }),
    safeDeliverReply: async () => true,
    markTranscriptReplyDelivered: () => {},
  });
  assert.equal(result, true);
});

test("handleWecomBotDispatchError uses transcript fallback and marks delivered", async () => {
  const markCalls = [];
  const deliverCalls = [];
  const result = await handleWecomBotDispatchError({
    api: { logger: { warn() {} } },
    err: new Error("other error"),
    dispatchStartedAt: 1000,
    isDispatchTimeoutError: () => false,
    startLateReplyWatcher: () => false,
    sessionId: "wecom-bot:u2",
    fromUser: "u2",
    buildWecomBotSessionId: (u) => `wecom-bot:${u}`,
    runtime: { channel: { session: { resolveStorePath: () => "/tmp/store" } } },
    cfg: {},
    routedAgentId: "main",
    readTranscriptFallbackResult: async () => ({ text: "late text", transcriptMessageId: "m1" }),
    safeDeliverReply: async (text, reason) => {
      deliverCalls.push({ text, reason });
      return true;
    },
    markTranscriptReplyDelivered: (...args) => markCalls.push(args),
  });
  assert.equal(result, true);
  assert.deepEqual(deliverCalls, [{ text: "late text", reason: "catch-transcript-fallback" }]);
  assert.deepEqual(markCalls, [["wecom-bot:u2", "m1"]]);
});
