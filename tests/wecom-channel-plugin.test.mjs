import assert from "node:assert/strict";
import test from "node:test";

import { createWecomChannelPlugin } from "../src/wecom/channel-plugin.js";
import {
  __resetWecomInboundActivityForTests,
  markWecomInboundActivity,
} from "../src/wecom/channel-status-state.js";

function createPluginHarness(overrides = {}) {
  const calls = {
    sendText: [],
    webhookText: [],
    webhookMedia: [],
    outboundMedia: [],
  };
  const logger = { info() {}, warn() {}, error() {} };
  const directConfig = {
    corpId: "ww1",
    corpSecret: "sec",
    agentId: "1001",
    outboundProxy: "",
    apiProxy: "https://wecom-proxy.example.com",
    webhooks: { ops: { url: "https://example.com", key: "k1" } },
  };
  const runtime = { config: { channels: { wecom: {} } }, logger };

  const plugin = createWecomChannelPlugin({
    listWecomAccountIds: () => ["default"],
    getWecomConfig: () => directConfig,
    getGatewayRuntime: () => runtime,
    normalizeWecomResolvedTarget: (to) => {
      if (to === "webhook") return { webhook: "ops" };
      if (to === "direct") return { toUser: "alice" };
      return null;
    },
    formatWecomTargetForLog: (target) => JSON.stringify(target),
    sendWecomWebhookText: async (payload) => {
      calls.webhookText.push(payload);
    },
    sendWecomWebhookMediaBatch: async (payload) => {
      calls.webhookMedia.push(payload);
      return { total: 1, sentCount: 1, failed: [] };
    },
    sendWecomOutboundMediaBatch: async (payload) => {
      calls.outboundMedia.push(payload);
      return { total: 1, sentCount: 1, failed: [] };
    },
    sendWecomText: async (payload) => {
      calls.sendText.push(payload);
    },
    ...overrides,
  });

  return { plugin, calls };
}

test("channel plugin outbound.sendText supports webhook target", async () => {
  const { plugin, calls } = createPluginHarness();
  const result = await plugin.outbound.sendText({ to: "webhook", text: "hello" });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "wecom-webhook");
  assert.equal(calls.webhookText.length, 1);
  assert.equal(calls.sendText.length, 0);
});

test("channel plugin inbound.deliverReply sends media + text for direct target", async () => {
  const { plugin, calls } = createPluginHarness();
  const result = await plugin.inbound.deliverReply({
    to: "direct",
    text: "done",
    mediaUrl: "https://example.com/a.png",
    mediaType: "image",
  });
  assert.equal(result.ok, true);
  assert.equal(calls.outboundMedia.length, 1);
  assert.equal(calls.sendText.length, 1);
  assert.equal(calls.outboundMedia[0]?.apiProxy, "https://wecom-proxy.example.com");
  assert.equal(calls.sendText[0]?.apiProxy, "https://wecom-proxy.example.com");
});

test("channel plugin resolveTarget validates target", () => {
  const { plugin } = createPluginHarness();
  const fail = plugin.outbound.resolveTarget({ to: "" });
  assert.equal(fail.ok, false);
});

test("channel plugin status localizes default account name and computes connected", () => {
  __resetWecomInboundActivityForTests();
  const { plugin } = createPluginHarness();
  const account = plugin.config.resolveAccount({}, "default");
  const snapshot = plugin.status.buildAccountSnapshot({
    account,
    cfg: { channels: { wecom: {} } },
    runtime: {},
  });
  assert.equal(snapshot.accountId, "default");
  assert.equal(snapshot.name, "默认账号");
  assert.equal(snapshot.connected, true);

  const summary = plugin.status.buildChannelSummary({ snapshot });
  assert.equal(summary.connected, true);
});

test("channel plugin status exposes last inbound timestamp from webhook activity", () => {
  __resetWecomInboundActivityForTests();
  markWecomInboundActivity({ accountId: "default", timestamp: 1700000000 });
  const { plugin } = createPluginHarness();
  const account = plugin.config.resolveAccount({}, "default");
  const snapshot = plugin.status.buildAccountSnapshot({
    account,
    cfg: { channels: { wecom: {} } },
    runtime: {},
  });
  assert.ok(Number.isFinite(snapshot.lastInboundAt));

  const summary = plugin.status.buildChannelSummary({ snapshot });
  assert.equal(summary.lastInbound, snapshot.lastInboundAt);
  assert.equal(summary.lastInbound, 1700000000 * 1000);
});
