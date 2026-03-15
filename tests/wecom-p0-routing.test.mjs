import assert from "node:assert/strict";
import test from "node:test";

import { createWecomDeliveryRouter, parseWecomResponseUrlResult } from "../src/core/delivery-router.js";
import { WecomSessionTaskQueue, WecomStreamManager } from "../src/core/stream-manager.js";
import { resolveWebhookBotSendUrl } from "../src/wecom/webhook-bot.js";

test("WecomStreamManager create/update/finish/cleanup works", () => {
  const manager = new WecomStreamManager({ expireMs: 1000, maxBytes: 32 });
  manager.create("stream-a", "hello", { feedbackId: "fb-1" });
  assert.equal(manager.has("stream-a"), true);
  assert.equal(manager.get("stream-a")?.feedbackId, "fb-1");
  manager.update("stream-a", " world", { append: true });
  assert.equal(manager.get("stream-a")?.content, "hello world");
  manager.finish("stream-a");
  assert.equal(manager.get("stream-a")?.finished, true);

  manager.create("stream-b", "x");
  const streamB = manager.get("stream-b");
  streamB.updatedAt = Date.now() - 5000;
  const removed = manager.cleanup(1000);
  assert.equal(removed >= 1, true);
});

test("WecomSessionTaskQueue serializes tasks per session", async () => {
  const queue = new WecomSessionTaskQueue({ maxConcurrentPerSession: 1 });
  const order = [];
  await Promise.all([
    queue.enqueue("wecom:alice", async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first:end");
    }),
    queue.enqueue("wecom:alice", async () => {
      order.push("second:start");
      order.push("second:end");
    }),
  ]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("delivery router uses active_stream only when fallback disabled", async () => {
  const hits = [];
  const router = createWecomDeliveryRouter({
    fallbackConfig: {
      enabled: false,
      order: ["active_stream", "response_url", "webhook_bot", "agent_push"],
    },
    handlers: {
      active_stream: async () => {
        hits.push("active_stream");
        return { ok: true };
      },
      response_url: async () => {
        hits.push("response_url");
        return { ok: true };
      },
    },
    observability: { enabled: false },
  });
  const result = await router.deliverText({ text: "hello", traceId: "trace-1" });
  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.equal(result.deliveryPath, "active_stream");
  assert.equal(result.finalStatus, "ok");
  assert.equal(result.deliveryStatus, "delivered");
  assert.equal(result.attempts[0].status, "ok");
  assert.equal(result.attempts[0].deliveryStatus, "delivered");
  assert.deepEqual(hits, ["active_stream"]);
});

test("delivery router falls through to next layer on rejection", async () => {
  const hits = [];
  const router = createWecomDeliveryRouter({
    fallbackConfig: {
      enabled: true,
      order: ["active_stream", "response_url", "webhook_bot", "agent_push"],
    },
    handlers: {
      active_stream: async () => {
        hits.push("active_stream");
        return { ok: false, reason: "stream-missing" };
      },
      response_url: async () => {
        hits.push("response_url");
        return { ok: true };
      },
    },
    observability: { enabled: false },
  });
  const result = await router.deliverText({ text: "world", traceId: "trace-2" });
  assert.equal(result.ok, true);
  assert.equal(result.layer, "response_url");
  assert.equal(result.deliveryPath, "response_url");
  assert.equal(result.finalStatus, "degraded");
  assert.equal(result.deliveryStatus, "delivered");
  assert.equal(result.attempts[0].status, "miss");
  assert.equal(result.attempts[0].deliveryStatus, "rejected_target");
  assert.equal(result.attempts[1].status, "ok");
  assert.deepEqual(hits, ["active_stream", "response_url"]);
});

test("delivery router classifies failures across layers", async () => {
  const router = createWecomDeliveryRouter({
    fallbackConfig: {
      enabled: true,
      order: ["active_stream", "agent_push"],
    },
    handlers: {
      active_stream: async () => ({ ok: false, reason: "stream-missing" }),
      agent_push: async () => {
        throw new Error("fetch failed");
      },
    },
    observability: { enabled: false },
  });
  const result = await router.deliverText({ text: "world", traceId: "trace-3" });
  assert.equal(result.ok, false);
  assert.equal(result.finalStatus, "failed");
  assert.equal(result.deliveryStatus, "rejected_transport");
  assert.equal(result.attempts[0].deliveryStatus, "rejected_target");
  assert.equal(result.attempts[1].deliveryStatus, "rejected_transport");
});

test("parseWecomResponseUrlResult parses accepted responses", () => {
  const result = parseWecomResponseUrlResult(
    { ok: true },
    JSON.stringify({ errcode: 0, errmsg: "ok" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.errcode, 0);
});

test("resolveWebhookBotSendUrl supports key fallback", () => {
  const fromKey = resolveWebhookBotSendUrl({ key: "abc123" });
  assert.ok(fromKey.includes("webhook/send?key=abc123"));
  const fromUrl = resolveWebhookBotSendUrl({ url: "https://example.com/webhook?key=xyz" });
  assert.equal(fromUrl, "https://example.com/webhook?key=xyz");
});
