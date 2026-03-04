import assert from "node:assert/strict";
import test from "node:test";

import { createWecomPluginBaseServices } from "../src/wecom/plugin-base-services.js";
import { createWecomPluginAccountPolicyServices } from "../src/wecom/plugin-account-policy-services.js";

test("createWecomPluginAccountPolicyServices returns account/policy/command bindings", () => {
  const base = createWecomPluginBaseServices();
  const services = createWecomPluginAccountPolicyServices({
    getGatewayRuntime: base.getGatewayRuntime,
    normalizeWecomResolvedTarget: base.normalizeWecomResolvedTarget,
    formatWecomTargetForLog: base.formatWecomTargetForLog,
    sendWecomWebhookText: base.sendWecomWebhookText,
    sendWecomWebhookMediaBatch: base.sendWecomWebhookMediaBatch,
    sendWecomOutboundMediaBatch: base.sendWecomOutboundMediaBatch,
    sendWecomText: base.sendWecomText,
  });

  assert.equal(typeof services.getWecomConfig, "function");
  assert.equal(typeof services.listEnabledWecomAccounts, "function");
  assert.equal(typeof services.resolveWecomBotConfig, "function");
  assert.equal(typeof services.resolveWecomCommandPolicy, "function");
  assert.equal(typeof services.resolveWecomVoiceTranscriptionConfig, "function");
  assert.equal(typeof services.COMMANDS, "object");
  assert.equal(typeof services.WecomChannelPlugin, "object");
});
