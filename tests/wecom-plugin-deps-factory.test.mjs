import assert from "node:assert/strict";
import test from "node:test";

import { createPluginProcessingDeps } from "../src/wecom/plugin-processing-deps.js";
import { createPluginRouteRuntimeDeps } from "../src/wecom/plugin-route-runtime-deps.js";
import {
  createPluginProcessingDeps as createPluginProcessingDepsFromFactory,
  createPluginRouteRuntimeDeps as createPluginRouteRuntimeDepsFromFactory,
} from "../src/wecom/plugin-deps-factory.js";

test("plugin-deps-factory re-exports split dependency builders", () => {
  assert.equal(createPluginProcessingDepsFromFactory, createPluginProcessingDeps);
  assert.equal(createPluginRouteRuntimeDepsFromFactory, createPluginRouteRuntimeDeps);
});

test("createPluginProcessingDeps maps context into three dependency groups", () => {
  const fn = () => {};
  const deps = createPluginProcessingDeps({
    buildWecomBotSessionId: fn,
    resolveWecomBotConfig: fn,
    resolveWecomBotProxyConfig: fn,
    normalizeWecomBotOutboundMediaUrls: fn,
    resolveWecomGroupChatPolicy: fn,
    resolveWecomDynamicAgentPolicy: fn,
    hasBotStream: fn,
    finishBotStream: fn,
    deliverBotReplyText: fn,
    shouldTriggerWecomGroupResponse: fn,
    shouldStripWecomGroupMentions: fn,
    stripWecomGroupMentions: fn,
    resolveWecomCommandPolicy: fn,
    resolveWecomAllowFromPolicy: fn,
    isWecomSenderAllowed: fn,
    extractLeadingSlashCommand: fn,
    buildWecomBotHelpText: fn,
    buildWecomBotStatusText: fn,
    buildBotInboundContent: fn,
    resolveWecomAgentRoute: fn,
    seedDynamicAgentWorkspace: fn,
    resolveSessionTranscriptFilePath: fn,
    readTranscriptAppendedChunk: fn,
    parseLateAssistantReplyFromTranscriptLine: fn,
    hasTranscriptReplyBeenDelivered: fn,
    markTranscriptReplyDelivered: fn,
    markdownToWecomText: fn,
    sleep: fn,
    withTimeout: fn,
    isDispatchTimeoutError: fn,
    queueBotStreamMedia: fn,
    updateBotStream: fn,
    isAgentFailureText: fn,
    scheduleTempFileCleanup: fn,
    ACTIVE_LATE_REPLY_WATCHERS: new Map(),
    getWecomConfig: fn,
    buildWecomSessionId: fn,
    sendWecomText: fn,
    COMMANDS: { "/help": fn },
    buildInboundContent: fn,
    resolveWecomReplyStreamingPolicy: fn,
    asNumber: fn,
    requireEnv: fn,
    getByteLength: fn,
    autoSendWorkspaceFilesFromReplyText: fn,
    sendWecomOutboundMediaBatch: fn,
    resolveWecomTextDebouncePolicy: fn,
    messageProcessLimiter: { execute: fn },
    executeInboundTaskWithSessionQueue: fn,
  });

  assert.equal(typeof deps.botInboundDeps, "object");
  assert.equal(typeof deps.agentInboundDeps, "object");
  assert.equal(typeof deps.textSchedulerDeps, "object");
  assert.equal(deps.botInboundDeps.buildWecomBotSessionId, fn);
  assert.equal(deps.botInboundDeps.buildBotInboundContent, fn);
  assert.equal(deps.agentInboundDeps.sendWecomText, fn);
  assert.equal(deps.textSchedulerDeps.executeInboundTaskWithSessionQueue, fn);
});

test("createPluginRouteRuntimeDeps maps route/runtime dependencies", () => {
  const fn = () => {};
  const deps = createPluginRouteRuntimeDeps({
    resolveWecomBotConfig: fn,
    resolveWecomBotConfigs: fn,
    normalizePluginHttpPath: fn,
    ensureBotStreamCleanupTimer: fn,
    cleanupExpiredBotStreams: fn,
    createWecomBotWebhookHandler: fn,
    createWecomAgentWebhookHandler: fn,
    readRequestBody: fn,
    parseIncomingJson: fn,
    parseIncomingXml: fn,
    pickAccountBySignature: fn,
    decryptWecom: fn,
    computeMsgSignature: fn,
    parseWecomBotInboundMessage: fn,
    describeWecomBotParsedMessage: fn,
    markInboundMessageSeen: fn,
    extractWecomXmlInboundEnvelope: fn,
    buildWecomSessionId: fn,
    buildWecomBotSessionId: fn,
    buildWecomBotEncryptedResponse: fn,
    createBotStream: fn,
    getBotStream: fn,
    upsertBotResponseUrlCache: fn,
    messageProcessLimiter: { execute: fn },
    executeInboundTaskWithSessionQueue: fn,
    processBotInboundMessage: fn,
    processInboundMessage: fn,
    scheduleTextInboundProcessing: fn,
    deliverBotReplyText: fn,
    finishBotStream: fn,
    groupAccountsByWebhookPath: fn,
    setGatewayRuntime: fn,
    syncWecomSessionQueuePolicy: fn,
    resolveWecomDeliveryFallbackPolicy: fn,
    resolveWecomWebhookBotDeliveryPolicy: fn,
    resolveWecomObservabilityPolicy: fn,
    resolveWecomDynamicAgentPolicy: fn,
    getWecomConfig: fn,
    wecomChannelPlugin: { id: "wecom" },
  });
  assert.equal(typeof deps.routeRegistrarDeps, "object");
  assert.equal(typeof deps.registerRuntimeDeps, "object");
  assert.equal(deps.routeRegistrarDeps.readRequestBody, fn);
  assert.equal(deps.registerRuntimeDeps.getWecomConfig, fn);
});
