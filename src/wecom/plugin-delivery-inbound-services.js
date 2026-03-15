import { writeFile, mkdir } from "node:fs/promises";
import { WECOM_TEMP_DIR_NAME, BOOTSTRAP_TEMPLATE_FILES } from "./plugin-constants.js";
import { SEEDED_AGENT_WORKSPACES } from "./plugin-shared-state.js";
import { WecomSessionTaskQueue } from "../core/stream-manager.js";
import { createWecomBotReplyDeliverer } from "./outbound-delivery.js";
import { createWecomAgentReplyDeliverer } from "./outbound-agent-delivery.js";
import { createWecomInboundContentBuilder } from "./inbound-content.js";
import { createDynamicWorkspaceSeeder } from "./workspace-tools.js";
import { createWecomSessionQueueManager } from "./session-queue.js";
import { createDeliveryTraceId, buildWecomBotSessionId } from "./runtime-utils.js";

export function createWecomPluginDeliveryInboundServices({
  resolveWecomStreamManagerPolicy,
  setBotStreamExpireMs,
  attachWecomProxyDispatcher,
  resolveWecomDeliveryFallbackPolicy,
  resolveWecomReasoningPolicy,
  resolveWecomReplyFormatPolicy,
  resolveWecomWebhookBotDeliveryPolicy,
  resolveWecomObservabilityPolicy,
  resolveWecomBotProxyConfig,
  resolveWecomBotConfig,
  resolveWecomBotLongConnectionReplyContext,
  pushWecomBotLongConnectionStreamUpdate,
  upsertBotResponseUrlCache,
  getBotResponseUrlCache,
  markBotResponseUrlUsed,
  hasBotStream,
  resolveBotActiveStream,
  finishBotStream,
  drainBotStreamMedia,
  getWecomConfig,
  sendWecomText,
  sendWecomMarkdown,
  fetchMediaFromUrl,
  extractWorkspacePathsFromText,
  resolveWorkspacePathToHost,
  recordDeliveryMetric,
  recordReliableDeliveryOutcome,
  enqueuePendingReply,
  sendWecomOutboundMediaBatch,
  downloadWecomMedia,
  resolveWecomVoiceTranscriptionConfig,
  transcribeInboundVoice,
} = {}) {
  const { seedDynamicAgentWorkspace } = createDynamicWorkspaceSeeder({
    bootstrapTemplateFiles: BOOTSTRAP_TEMPLATE_FILES,
    seededAgentWorkspaces: SEEDED_AGENT_WORKSPACES,
  });

  const { syncWecomSessionQueuePolicy, executeInboundTaskWithSessionQueue } = createWecomSessionQueueManager({
    WecomSessionTaskQueue,
    resolveWecomStreamManagerPolicy,
    setBotStreamExpireMs,
    initialMaxConcurrentPerSession: 1,
  });

  const { deliverBotReplyText } = createWecomBotReplyDeliverer({
    attachWecomProxyDispatcher,
    resolveWecomDeliveryFallbackPolicy,
    resolveWecomReasoningPolicy,
    resolveWecomReplyFormatPolicy,
    resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomObservabilityPolicy,
    resolveWecomBotProxyConfig,
    resolveWecomBotConfig,
    resolveWecomBotLongConnectionReplyContext,
    pushWecomBotLongConnectionStreamUpdate,
    buildWecomBotSessionId,
    upsertBotResponseUrlCache,
    getBotResponseUrlCache,
    markBotResponseUrlUsed,
    createDeliveryTraceId,
    hasBotStream,
    resolveActiveBotStreamId: resolveBotActiveStream,
    finishBotStream,
    drainBotStreamMedia,
    getWecomConfig,
    sendWecomText,
    fetchMediaFromUrl,
    extractWorkspacePathsFromText,
    resolveWorkspacePathToHost,
    recordDeliveryMetric,
    recordReliableDeliveryOutcome,
    enqueuePendingReply,
  });
  const deliverAgentReply = createWecomAgentReplyDeliverer({
    getWecomConfig,
    sendWecomText,
    sendWecomMarkdown,
    sendWecomOutboundMediaBatch,
    resolveWecomReasoningPolicy,
    resolveWecomReplyFormatPolicy,
    resolveWorkspacePathToHost,
    createDeliveryTraceId,
    recordDeliveryMetric,
    recordReliableDeliveryOutcome,
    enqueuePendingReply,
  });

  const { buildInboundContent } = createWecomInboundContentBuilder({
    tempDirName: WECOM_TEMP_DIR_NAME,
    downloadWecomMedia,
    fetchMediaFromUrl,
    resolveWecomVoiceTranscriptionConfig,
    transcribeInboundVoice,
    sendWecomText,
    ensureDir: mkdir,
    writeFile,
  });

  return {
    seedDynamicAgentWorkspace,
    syncWecomSessionQueuePolicy,
    executeInboundTaskWithSessionQueue,
    deliverBotReplyText,
    deliverAgentReply,
    buildInboundContent,
  };
}
