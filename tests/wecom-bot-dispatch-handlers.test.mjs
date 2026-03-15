import assert from "node:assert/strict";
import test from "node:test";

import {
  createWecomBotDispatchHandlers,
  normalizeWecomBotBlockText,
} from "../src/wecom/bot-dispatch-handlers.js";

test("normalizeWecomBotBlockText merges streaming chunks", () => {
  assert.equal(normalizeWecomBotBlockText("", "a"), "a");
  assert.equal(normalizeWecomBotBlockText("a", "ab"), "ab");
  assert.equal(normalizeWecomBotBlockText("ab", "b"), "ab");
  assert.equal(normalizeWecomBotBlockText("ab", "cd"), "abcd");
});

test("createWecomBotDispatchHandlers handles block payload and queues media", async () => {
  const queued = [];
  const updates = [];
  const state = { blockText: "", streamFinished: false };
  const handlers = createWecomBotDispatchHandlers({
    api: { logger: { debug() {} } },
    streamId: "stream-1",
    state,
    hasBotStream: () => true,
    normalizeWecomBotOutboundMediaUrls: () => ["https://img.test/a.png"],
    queueBotStreamMedia: (streamId, mediaUrl, options) => queued.push({ streamId, mediaUrl, options }),
    updateBotStream: (streamId, text, options) => updates.push({ streamId, text, options }),
    markdownToWecomText: (text) => `fmt:${text}`,
    isAgentFailureText: () => false,
    safeDeliverReply: async () => false,
  });

  await handlers.deliver(
    {
      text: "hello",
      mediaType: "image",
    },
    { kind: "block" },
  );

  assert.equal(state.blockText, "hello");
  assert.equal(state.streamFinished, false);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], {
    streamId: "stream-1",
    mediaUrl: "https://img.test/a.png",
    options: { mediaType: "image" },
  });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    streamId: "stream-1",
    text: "fmt:hello",
    options: { append: false, finished: false, thinkingContent: "" },
  });
});

test("createWecomBotDispatchHandlers maps think tags into thinkingContent", async () => {
  const updates = [];
  const delivered = [];
  const state = { blockText: "", streamFinished: false };
  const handlers = createWecomBotDispatchHandlers({
    api: { logger: { debug() {}, error() {} } },
    streamId: "stream-think",
    state,
    hasBotStream: () => true,
    normalizeWecomBotOutboundMediaUrls: () => [],
    queueBotStreamMedia: () => {},
    updateBotStream: (streamId, text, options) => updates.push({ streamId, text, options }),
    markdownToWecomText: (text) => String(text).replace(/\*\*/g, ""),
    isAgentFailureText: () => false,
    safeDeliverReply: async (payload, reason) => {
      delivered.push({ payload, reason });
      return true;
    },
  });

  await handlers.deliver({ text: "<think>先分析</think>**最终**答案" }, { kind: "block" });
  assert.deepEqual(updates[0], {
    streamId: "stream-think",
    text: "最终答案",
    options: { append: false, finished: false, thinkingContent: "先分析" },
  });

  await handlers.deliver({ text: "<think>最后思路</think>输出结果" }, { kind: "final" });
  assert.deepEqual(delivered[0], {
    payload: {
      text: "输出结果",
      thinkingContent: "最后思路",
      rawText: "输出结果",
      rawThinkingContent: "最后思路",
    },
    reason: "final",
  });
});

test("createWecomBotDispatchHandlers handles final failure and onError", async () => {
  const delivered = [];
  const state = { blockText: "", streamFinished: false };
  const handlers = createWecomBotDispatchHandlers({
    api: { logger: { error() {}, debug() {} } },
    streamId: "stream-2",
    state,
    hasBotStream: () => true,
    normalizeWecomBotOutboundMediaUrls: () => [],
    queueBotStreamMedia: () => {},
    updateBotStream: () => {},
    markdownToWecomText: (text) => text,
    isAgentFailureText: () => true,
    safeDeliverReply: async (payload, reason) => {
      delivered.push({ payload, reason });
      return true;
    },
  });

  await handlers.deliver({ text: "upstream failed" }, { kind: "final" });
  assert.equal(state.streamFinished, true);
  assert.deepEqual(delivered[0], {
    payload: "抱歉，请求失败：upstream failed",
    reason: "upstream-failure",
  });

  state.streamFinished = false;
  await handlers.onError(new Error("boom"), { kind: "final" });
  assert.equal(state.streamFinished, true);
  assert.equal(delivered[1].reason, "dispatch-final-error");
  assert.match(String(delivered[1].payload), /当前模型请求失败/);
});

test("createWecomBotDispatchHandlers strips MEDIA directives from visible final text", async () => {
  const delivered = [];
  const state = { blockText: "", streamFinished: false };
  const handlers = createWecomBotDispatchHandlers({
    api: { logger: { error() {}, debug() {} } },
    streamId: "stream-3",
    state,
    hasBotStream: () => true,
    normalizeWecomBotOutboundMediaUrls: () => [],
    queueBotStreamMedia: () => {},
    updateBotStream: () => {},
    markdownToWecomText: (text) => text,
    isAgentFailureText: () => false,
    safeDeliverReply: async (payload, reason) => {
      delivered.push({ payload, reason });
      return true;
    },
  });

  await handlers.deliver({ text: "结果如下\nMEDIA: /workspace/out/chart.png" }, { kind: "final" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.text, "结果如下");
  assert.equal(delivered[0].payload.rawText, "结果如下\nMEDIA: /workspace/out/chart.png");
});
