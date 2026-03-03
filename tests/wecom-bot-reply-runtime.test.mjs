import assert from "node:assert/strict";
import test from "node:test";

import {
  createWecomBotDispatchState,
  createWecomBotLateReplyRuntime,
  resolveWecomBotReplyRuntimePolicy,
} from "../src/wecom/bot-reply-runtime.js";

test("createWecomBotDispatchState returns initialized mutable state", () => {
  const state = createWecomBotDispatchState();
  assert.equal(state.blockText, "");
  assert.equal(state.streamFinished, false);
});

test("resolveWecomBotReplyRuntimePolicy applies defaults and bounds", () => {
  const defaults = resolveWecomBotReplyRuntimePolicy({ botModeConfig: {} });
  assert.equal(defaults.replyTimeoutMs, 90000);
  assert.equal(defaults.lateReplyWatchMs, 180000);
  assert.equal(defaults.lateReplyPollMs, 2000);

  const bounded = resolveWecomBotReplyRuntimePolicy({
    botModeConfig: {
      replyTimeoutMs: "1000",
      lateReplyWatchMs: "1000",
      lateReplyPollMs: "100",
    },
  });
  assert.equal(bounded.replyTimeoutMs, 15000);
  assert.equal(bounded.lateReplyWatchMs, 30000);
  assert.equal(bounded.lateReplyPollMs, 500);
});

test("tryFinishFromTranscript delivers and marks transcript reply", async () => {
  const deliverCalls = [];
  const markCalls = [];
  const state = createWecomBotDispatchState();
  const runtime = createWecomBotLateReplyRuntime({
    logger: { info() {} },
    sessionId: "wecom-bot:user-a",
    sessionRuntimeId: "runtime-a",
    msgId: "msg-a",
    storePath: "/tmp/store",
    dispatchState: state,
    dispatchStartedAt: 100,
    lateReplyWatchMs: 60000,
    lateReplyPollMs: 2000,
    readTranscriptFallback: async () => ({ text: "hello from transcript", transcriptMessageId: "m-1" }),
    markTranscriptReplyDelivered: (...args) => markCalls.push(args),
    safeDeliverReply: async (text, reason) => {
      deliverCalls.push({ text, reason });
      return true;
    },
    runLateReplyWatcher: async () => {},
    activeWatchers: new Map(),
    now: () => 1000,
    randomToken: () => "abc123",
  });

  const delivered = await runtime.tryFinishFromTranscript();
  assert.equal(delivered, true);
  assert.equal(state.streamFinished, true);
  assert.deepEqual(deliverCalls, [{ text: "hello from transcript", reason: "transcript-fallback" }]);
  assert.deepEqual(markCalls, [["wecom-bot:user-a", "m-1"]]);
});

test("startLateReplyWatcher dispatches late transcript text", async () => {
  const deliverCalls = [];
  const state = createWecomBotDispatchState();
  let capturedOptions = null;
  const runtime = createWecomBotLateReplyRuntime({
    logger: { info() {}, warn() {} },
    sessionId: "wecom-bot:user-b",
    sessionRuntimeId: "runtime-b",
    msgId: "msg-b",
    storePath: "/tmp/store",
    dispatchState: state,
    dispatchStartedAt: 200,
    lateReplyWatchMs: 60000,
    lateReplyPollMs: 1000,
    readTranscriptFallback: async () => ({ text: "", transcriptMessageId: "" }),
    markTranscriptReplyDelivered: () => {},
    safeDeliverReply: async (text, reason) => {
      deliverCalls.push({ text, reason });
      return true;
    },
    runLateReplyWatcher: async (options) => {
      capturedOptions = options;
      await options.sendText("late reply text");
      options.markDelivered();
    },
    activeWatchers: new Map(),
    now: () => 5000,
    randomToken: () => "token42",
  });

  assert.equal(runtime.startLateReplyWatcher("dispatch-timeout", 3000), true);
  assert.equal(runtime.startLateReplyWatcher("dispatch-timeout", 3000), false);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(capturedOptions?.watchId, "wecom-bot:wecom-bot:user-b:msg-b:token42");
  assert.equal(capturedOptions?.reason, "dispatch-timeout");
  assert.deepEqual(deliverCalls, [{ text: "late reply text", reason: "late-transcript-fallback" }]);
  assert.equal(state.streamFinished, true);
});

test("startLateReplyWatcher failure fallback sends timeout text", async () => {
  const deliverCalls = [];
  const state = createWecomBotDispatchState();
  const runtime = createWecomBotLateReplyRuntime({
    logger: { info() {}, warn() {} },
    sessionId: "wecom-bot:user-c",
    sessionRuntimeId: "runtime-c",
    msgId: "msg-c",
    storePath: "/tmp/store",
    dispatchState: state,
    dispatchStartedAt: 200,
    lateReplyWatchMs: 60000,
    lateReplyPollMs: 1000,
    readTranscriptFallback: async () => ({ text: "", transcriptMessageId: "" }),
    markTranscriptReplyDelivered: () => {},
    safeDeliverReply: async (text, reason) => {
      deliverCalls.push({ text, reason });
      return true;
    },
    runLateReplyWatcher: async (options) => {
      await options.onFailureFallback("late reply watcher timed out after 60000ms");
    },
    activeWatchers: new Map(),
    now: () => 7000,
    randomToken: () => "token84",
  });

  assert.equal(runtime.startLateReplyWatcher("dispatch-timeout", 3000), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(deliverCalls.length, 1);
  assert.equal(deliverCalls[0].reason, "late-timeout-fallback");
  assert.equal(deliverCalls[0].text, "抱歉，当前模型请求超时或网络不稳定，请稍后重试。");
});
