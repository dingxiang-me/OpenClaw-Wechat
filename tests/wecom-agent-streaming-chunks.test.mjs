import assert from "node:assert/strict";
import test from "node:test";

import { createWecomAgentStreamingChunkManager } from "../src/wecom/agent-streaming-chunks.js";

function createState() {
  return {
    hasDeliveredReply: false,
    hasDeliveredPartialReply: false,
    streamChunkBuffer: "",
    streamChunkLastSentAt: 0,
    streamChunkSentCount: 0,
    streamChunkSendChain: Promise.resolve(),
  };
}

test("flushStreamingBuffer sends chunk when threshold is met", async () => {
  const sent = [];
  const state = createState();
  state.streamChunkBuffer = "hello world with enough chars";
  const manager = createWecomAgentStreamingChunkManager({
    state,
    streamingEnabled: true,
    streamingPolicy: { minChars: 5, minIntervalMs: 0 },
    markdownToWecomText: (text) => String(text),
    getByteLength: (text) => Buffer.byteLength(String(text), "utf8"),
    sendTextToUser: async (text) => sent.push(String(text)),
    logger: { info() {}, warn() {} },
    now: () => 2000,
  });

  const flushed = await manager.flushStreamingBuffer({ force: false, reason: "block" });
  assert.equal(flushed, true);
  assert.deepEqual(sent, ["hello world with enough chars"]);
  assert.equal(state.streamChunkBuffer, "");
  assert.equal(state.hasDeliveredPartialReply, true);
  assert.equal(state.streamChunkSentCount, 1);
});

test("flushStreamingBuffer respects minInterval when force is false", async () => {
  const sent = [];
  const state = createState();
  state.streamChunkBuffer = "this is long enough";
  state.streamChunkLastSentAt = 900;
  const manager = createWecomAgentStreamingChunkManager({
    state,
    streamingEnabled: true,
    streamingPolicy: { minChars: 5, minIntervalMs: 500 },
    markdownToWecomText: (text) => String(text),
    getByteLength: (text) => Buffer.byteLength(String(text), "utf8"),
    sendTextToUser: async (text) => sent.push(String(text)),
    logger: { info() {}, warn() {} },
    now: () => 1000,
  });

  const flushed = await manager.flushStreamingBuffer({ force: false, reason: "block" });
  assert.equal(flushed, false);
  assert.deepEqual(sent, []);
  assert.equal(state.streamChunkBuffer, "this is long enough");
});

test("flushStreamingBuffer skips when streaming disabled or reply already delivered", async () => {
  const state = createState();
  state.streamChunkBuffer = "hello";
  const disabled = createWecomAgentStreamingChunkManager({
    state,
    streamingEnabled: false,
    streamingPolicy: { minChars: 1, minIntervalMs: 0 },
    markdownToWecomText: (text) => String(text),
    getByteLength: (text) => Buffer.byteLength(String(text), "utf8"),
    sendTextToUser: async () => {},
    logger: { info() {}, warn() {} },
  });
  assert.equal(await disabled.flushStreamingBuffer({ force: true }), false);

  state.hasDeliveredReply = true;
  const delivered = createWecomAgentStreamingChunkManager({
    state,
    streamingEnabled: true,
    streamingPolicy: { minChars: 1, minIntervalMs: 0 },
    markdownToWecomText: (text) => String(text),
    getByteLength: (text) => Buffer.byteLength(String(text), "utf8"),
    sendTextToUser: async () => {},
    logger: { info() {}, warn() {} },
  });
  assert.equal(await delivered.flushStreamingBuffer({ force: true }), false);
});
