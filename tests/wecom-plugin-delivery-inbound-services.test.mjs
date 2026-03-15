import assert from "node:assert/strict";
import test from "node:test";

import { createWecomPluginBaseServices } from "../src/wecom/plugin-base-services.js";
import { createWecomPluginAccountPolicyServices } from "../src/wecom/plugin-account-policy-services.js";
import { createWecomPluginDeliveryInboundServices } from "../src/wecom/plugin-delivery-inbound-services.js";

test("createWecomPluginDeliveryInboundServices returns queue/delivery/inbound builders", () => {
  const base = createWecomPluginBaseServices();
  const accountPolicy = createWecomPluginAccountPolicyServices({
    getGatewayRuntime: base.getGatewayRuntime,
    normalizeWecomResolvedTarget: base.normalizeWecomResolvedTarget,
    formatWecomTargetForLog: base.formatWecomTargetForLog,
    sendWecomWebhookText: base.sendWecomWebhookText,
    sendWecomWebhookMediaBatch: base.sendWecomWebhookMediaBatch,
    sendWecomOutboundMediaBatch: base.sendWecomOutboundMediaBatch,
    sendWecomText: base.sendWecomText,
  });

  const services = createWecomPluginDeliveryInboundServices({
    resolveWecomStreamManagerPolicy: accountPolicy.resolveWecomStreamManagerPolicy,
    setBotStreamExpireMs: base.setBotStreamExpireMs,
    attachWecomProxyDispatcher: base.attachWecomProxyDispatcher,
    resolveWecomDeliveryFallbackPolicy: accountPolicy.resolveWecomDeliveryFallbackPolicy,
    resolveWecomReasoningPolicy: accountPolicy.resolveWecomReasoningPolicy,
    resolveWecomWebhookBotDeliveryPolicy: accountPolicy.resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomObservabilityPolicy: accountPolicy.resolveWecomObservabilityPolicy,
    resolveWecomBotProxyConfig: accountPolicy.resolveWecomBotProxyConfig,
    resolveWecomBotConfig: accountPolicy.resolveWecomBotConfig,
    resolveWecomBotLongConnectionReplyContext: () => null,
    pushWecomBotLongConnectionStreamUpdate: async () => ({ ok: false, reason: "context-missing" }),
    upsertBotResponseUrlCache: base.upsertBotResponseUrlCache,
    getBotResponseUrlCache: base.getBotResponseUrlCache,
    markBotResponseUrlUsed: base.markBotResponseUrlUsed,
    hasBotStream: base.hasBotStream,
    resolveBotActiveStream: base.resolveBotActiveStream,
    finishBotStream: base.finishBotStream,
    drainBotStreamMedia: base.drainBotStreamMedia,
    getWecomConfig: accountPolicy.getWecomConfig,
    sendWecomText: base.sendWecomText,
    fetchMediaFromUrl: base.fetchMediaFromUrl,
    recordDeliveryMetric: base.recordDeliveryMetric,
    recordReliableDeliveryOutcome: base.recordReliableDeliveryOutcome,
    enqueuePendingReply: () => null,
    sendWecomOutboundMediaBatch: base.sendWecomOutboundMediaBatch,
    downloadWecomMedia: base.downloadWecomMedia,
    resolveWecomVoiceTranscriptionConfig: accountPolicy.resolveWecomVoiceTranscriptionConfig,
    transcribeInboundVoice: accountPolicy.transcribeInboundVoice,
  });

  assert.equal(typeof services.seedDynamicAgentWorkspace, "function");
  assert.equal(typeof services.syncWecomSessionQueuePolicy, "function");
  assert.equal(typeof services.executeInboundTaskWithSessionQueue, "function");
  assert.equal(typeof services.deliverBotReplyText, "function");
  assert.equal(typeof services.deliverAgentReply, "function");
  assert.equal(typeof services.buildInboundContent, "function");
});
