import assert from "node:assert/strict";
import test from "node:test";

import { createWecomActiveStreamDeliverer } from "../src/wecom/outbound-active-stream.js";

function createDeliverer(overrides = {}) {
  const finished = [];
  const base = {
    hasBotStream: (id) => id === "stream-ok" || id === "stream-recovered",
    resolveActiveBotStreamId: () => "",
    drainBotStreamMedia: () => [],
    normalizeWecomBotOutboundMediaUrls: ({ mediaUrls }) => {
      const list = Array.isArray(mediaUrls) ? mediaUrls : [];
      return Array.from(new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean)));
    },
    buildActiveStreamMsgItems: async ({ mediaUrls }) => ({
      msgItem: mediaUrls.map((url) => ({ msgtype: "image", image: { url } })),
      fallbackUrls: [],
    }),
    finishBotStream: (streamId, content, options) => {
      finished.push({ streamId, content, options });
    },
    fetchMediaFromUrl: async () => ({ buffer: Buffer.from("ok") }),
  };
  return {
    deliver: createWecomActiveStreamDeliverer({ ...base, ...overrides }),
    finished,
  };
}

test("deliverActiveStreamReply returns stream-missing when stream unavailable", async () => {
  const { deliver } = createDeliverer({
    hasBotStream: () => false,
    resolveActiveBotStreamId: () => "",
  });
  const result = await deliver({
    streamId: "stream-missing",
    sessionId: "wecom-bot:u1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stream-missing");
});

test("deliverActiveStreamReply recovers stream by session id", async () => {
  const { deliver, finished } = createDeliverer({
    hasBotStream: (id) => id === "stream-recovered",
    resolveActiveBotStreamId: () => "stream-recovered",
  });
  const result = await deliver({
    streamId: "stream-missing",
    sessionId: "wecom-bot:u1",
    content: "hello",
  });
  assert.equal(result.ok, true);
  assert.equal(result.meta.recoveredBySession, true);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].streamId, "stream-recovered");
});

test("deliverActiveStreamReply merges queued media and appends fallback links", async () => {
  const { deliver, finished } = createDeliverer({
    drainBotStreamMedia: () => [{ url: "https://example.com/q.png", mediaType: "image" }],
    buildActiveStreamMsgItems: async () => ({
      msgItem: [],
      fallbackUrls: ["https://example.com/q.png"],
    }),
  });
  const result = await deliver({
    streamId: "stream-ok",
    sessionId: "wecom-bot:u1",
    content: "",
    normalizedMediaUrls: [],
    fallbackText: "媒体结果",
  });
  assert.equal(result.ok, true);
  assert.equal(result.meta.mediaAsLinks, true);
  assert.equal(result.meta.queuedMediaCount, 1);
  assert.match(finished[0].content, /媒体链接/);
  assert.match(finished[0].content, /https:\/\/example.com\/q\.png/);
});

test("deliverActiveStreamReply uses default text when no content and no media", async () => {
  const { deliver, finished } = createDeliverer({
    buildActiveStreamMsgItems: async () => ({ msgItem: [], fallbackUrls: [] }),
  });
  const result = await deliver({
    streamId: "stream-ok",
    sessionId: "wecom-bot:u1",
    content: "",
    normalizedMediaUrls: [],
    fallbackText: "",
  });
  assert.equal(result.ok, true);
  assert.equal(finished[0].content, "已收到模型返回的结果。");
});
