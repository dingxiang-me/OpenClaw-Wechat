import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ProxyAgent } from "undici";
import { normalizePluginHttpPath } from "./http-path.js";
import { WECOM_TEMP_DIR_NAME } from "./plugin-constants.js";
import { ACTIVE_LATE_REPLY_WATCHERS } from "./plugin-shared-state.js";
import { resolveWecomAgentRoute } from "../core/agent-routing.js";
import {
  decryptWecomPayload as decryptWecom,
  decryptWecomMediaBuffer,
} from "./crypto-utils.js";
import { createWecomBotWebhookHandler } from "./bot-webhook-handler.js";
import { createWecomAgentWebhookHandler } from "./agent-webhook-handler.js";
import {
  asNumber,
  buildWecomBotSessionId,
  isAgentFailureText,
  isDispatchTimeoutError,
  requireEnv,
  sleep,
  withTimeout,
} from "./runtime-utils.js";
import {
  parseLateAssistantReplyFromTranscriptLine,
  readTranscriptAppendedChunk,
  resolveSessionTranscriptFilePath,
} from "./transcript-utils.js";
import { detectImageContentTypeFromBuffer, pickImageFileExtension } from "./media-url-utils.js";
import {
  describeWecomBotParsedMessage,
  extractWecomXmlInboundEnvelope,
  normalizeWecomBotOutboundMediaUrls,
  parseWecomBotInboundMessage,
} from "./webhook-adapter.js";
import {
  buildMediaFetchErrorMessage,
  inferFilenameFromMediaDownload,
  smartDecryptWecomFileBuffer,
} from "./media-download.js";
import { createWecomPluginBaseServices } from "./plugin-base-services.js";
import { createWecomPluginAccountPolicyServices } from "./plugin-account-policy-services.js";
import { createWecomPluginDeliveryInboundServices } from "./plugin-delivery-inbound-services.js";
import { createWecomPendingReplyManager } from "./pending-reply-manager.js";
import { createWecomReliableDeliveryPersistence } from "./reliable-delivery-persistence.js";
import { createWecomBotInboundContentBuilder } from "./bot-inbound-content.js";
import { createWecomBotLongConnectionManager } from "./bot-long-connection-manager.js";
import { createWecomDocToolRegistrar } from "./doc-tool.js";
import { createWecomSessionResetter } from "./session-reset.js";
import { markdownToWecomText } from "./text-format.js";
import {
  buildWecomSessionId,
  buildInboundDedupeKey,
  computeMsgSignature,
  extractLeadingSlashCommand,
  getByteLength,
  isWecomSenderAllowed,
  markInboundMessageSeen,
  pickAccountBySignature,
  resetInboundMessageDedupeForTests,
  resolveWecomWebhookTargetConfig,
  shouldStripWecomGroupMentions,
  shouldTriggerWecomGroupResponse,
  splitWecomText,
  stripWecomGroupMentions,
} from "../core.js";

export function createWecomPluginServices({
  processEnv = process.env,
  fetchImpl = fetch,
  proxyAgentCtor = ProxyAgent,
} = {}) {
  let pendingReplyApi = null;
  const base = createWecomPluginBaseServices({
    fetchImpl,
    proxyAgentCtor,
  });

  const accountPolicy = createWecomPluginAccountPolicyServices({
    processEnv,
    getGatewayRuntime: base.getGatewayRuntime,
    getWecomObservabilityMetrics: base.getWecomObservabilityMetrics,
    getWecomReliableDeliverySnapshot: base.getWecomReliableDeliverySnapshot,
    normalizeWecomResolvedTarget: base.normalizeWecomResolvedTarget,
    formatWecomTargetForLog: base.formatWecomTargetForLog,
    sendWecomWebhookText: base.sendWecomWebhookText,
    sendWecomWebhookMediaBatch: base.sendWecomWebhookMediaBatch,
    sendWecomOutboundMediaBatch: base.sendWecomOutboundMediaBatch,
    sendWecomText: base.sendWecomText,
  });

  const reliableDeliveryPersistence = createWecomReliableDeliveryPersistence({
    reliableDeliveryStore: base.reliableDeliveryStore,
    resolveWecomPendingReplyPolicy: accountPolicy.resolveWecomPendingReplyPolicy,
    getGatewayRuntime: base.getGatewayRuntime,
    processEnv,
    logger: {
      warn: (...args) => pendingReplyApi?.logger?.warn?.(...args),
      debug: (...args) => pendingReplyApi?.logger?.debug?.(...args),
    },
  });

  function markWecomReliableInboundActivity(payload = {}) {
    const result = base.markWecomReliableInboundActivity(payload);
    reliableDeliveryPersistence.schedulePersist("reliable-inbound");
    return result;
  }

  function recordReliableDeliveryOutcome(payload = {}) {
    const result = base.recordReliableDeliveryOutcome(payload);
    reliableDeliveryPersistence.schedulePersist("reliable-delivery");
    return result;
  }

  const deliveryInbound = createWecomPluginDeliveryInboundServices({
    resolveWecomStreamManagerPolicy: accountPolicy.resolveWecomStreamManagerPolicy,
    setBotStreamExpireMs: base.setBotStreamExpireMs,
    attachWecomProxyDispatcher: base.attachWecomProxyDispatcher,
    resolveWecomDeliveryFallbackPolicy: accountPolicy.resolveWecomDeliveryFallbackPolicy,
    resolveWecomReasoningPolicy: accountPolicy.resolveWecomReasoningPolicy,
    resolveWecomReplyFormatPolicy: accountPolicy.resolveWecomReplyFormatPolicy,
    resolveWecomWebhookBotDeliveryPolicy: accountPolicy.resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomObservabilityPolicy: accountPolicy.resolveWecomObservabilityPolicy,
    resolveWecomBotProxyConfig: accountPolicy.resolveWecomBotProxyConfig,
    resolveWecomBotConfig: accountPolicy.resolveWecomBotConfig,
    resolveWecomBotLongConnectionReplyContext: (...args) => wecomBotLongConnectionManager.resolveReplyContext(...args),
    pushWecomBotLongConnectionStreamUpdate: (...args) => wecomBotLongConnectionManager.pushStreamUpdate(...args),
    upsertBotResponseUrlCache: base.upsertBotResponseUrlCache,
    getBotResponseUrlCache: base.getBotResponseUrlCache,
    markBotResponseUrlUsed: base.markBotResponseUrlUsed,
    hasBotStream: base.hasBotStream,
    resolveBotActiveStream: base.resolveBotActiveStream,
    finishBotStream: base.finishBotStream,
    drainBotStreamMedia: base.drainBotStreamMedia,
    getWecomConfig: accountPolicy.getWecomConfig,
    sendWecomText: base.sendWecomText,
    sendWecomMarkdown: base.sendWecomMarkdown,
    fetchMediaFromUrl: base.fetchMediaFromUrl,
    extractWorkspacePathsFromText: base.extractWorkspacePathsFromText,
    resolveWorkspacePathToHost: base.resolveWorkspacePathToHost,
    recordDeliveryMetric: base.recordDeliveryMetric,
    recordReliableDeliveryOutcome,
    enqueuePendingReply: (api, payload) => {
      pendingReplyApi = api ?? pendingReplyApi;
      return pendingReplyManager?.enqueuePendingReply?.(api, payload);
    },
    sendWecomOutboundMediaBatch: base.sendWecomOutboundMediaBatch,
    downloadWecomMedia: base.downloadWecomMedia,
    resolveWecomVoiceTranscriptionConfig: accountPolicy.resolveWecomVoiceTranscriptionConfig,
    transcribeInboundVoice: accountPolicy.transcribeInboundVoice,
  });
  const pendingReplyManager = createWecomPendingReplyManager({
    reliableDeliveryStore: base.reliableDeliveryStore,
    resolveWecomPendingReplyPolicy: accountPolicy.resolveWecomPendingReplyPolicy,
    ensurePersistenceLoaded: (api) => reliableDeliveryPersistence.ensureLoaded(api),
    schedulePersistenceFlush: (reason, api) => reliableDeliveryPersistence.schedulePersist(reason, api),
    deliverPendingReply: async (entry) => {
      if (entry?.mode === "bot") {
        return deliveryInbound.deliverBotReplyText({
          api: pendingReplyApi,
          fromUser: entry.fromUser,
          accountId: entry.accountId,
          sessionId: entry.sessionId,
          text: entry.payload?.text,
          thinkingContent: entry.payload?.thinkingContent,
          mediaItems: entry.payload?.mediaItems,
          mediaUrls: entry.payload?.mediaUrls,
          mediaType: entry.payload?.mediaType,
          reason: "pending-reply",
          allowPendingEnqueue: false,
        });
      }
      return deliveryInbound.deliverAgentReply({
        api: pendingReplyApi,
        fromUser: entry.fromUser,
        accountId: entry.accountId,
        sessionId: entry.sessionId,
        text: entry.payload?.text,
        thinkingContent: entry.payload?.thinkingContent,
        mediaItems: entry.payload?.mediaItems,
        mediaUrls: entry.payload?.mediaUrls,
        mediaType: entry.payload?.mediaType,
        reason: "pending-reply",
        allowPendingEnqueue: false,
      });
    },
    logger: {
      warn: (...args) => pendingReplyApi?.logger?.warn?.(...args),
    },
  });
  const buildBotInboundContent = createWecomBotInboundContentBuilder({
    fetchMediaFromUrl: base.fetchMediaFromUrl,
    detectImageContentTypeFromBuffer,
    decryptWecomMediaBuffer,
    pickImageFileExtension,
    resolveWecomVoiceTranscriptionConfig: accountPolicy.resolveWecomVoiceTranscriptionConfig,
    transcribeInboundVoice: accountPolicy.transcribeInboundVoice,
    inferFilenameFromMediaDownload,
    smartDecryptWecomFileBuffer,
    basename,
    mkdir,
    tmpdir,
    join,
    writeFile,
    WECOM_TEMP_DIR_NAME,
  });
  const registerWecomDocTools = createWecomDocToolRegistrar({
    listEnabledWecomAccounts: accountPolicy.listEnabledWecomAccounts,
    normalizeAccountId: accountPolicy.normalizeAccountId,
    fetchWithRetry: base.fetchWithRetry,
    getWecomAccessToken: base.getWecomAccessToken,
  });
  const { resetWecomConversationSession, clearSessionStoreEntry } = createWecomSessionResetter();
  const wecomBotLongConnectionManager = createWecomBotLongConnectionManager({
    attachWecomProxyDispatcher: base.attachWecomProxyDispatcher,
    resolveWecomBotConfigs: accountPolicy.resolveWecomBotConfigs,
    resolveWecomBotProxyConfig: accountPolicy.resolveWecomBotProxyConfig,
    parseWecomBotInboundMessage,
    describeWecomBotParsedMessage,
    buildWecomBotSessionId,
    createBotStream: base.createBotStream,
    upsertBotResponseUrlCache: base.upsertBotResponseUrlCache,
    markInboundMessageSeen,
    messageProcessLimiter: base.messageProcessLimiter,
    executeInboundTaskWithSessionQueue: deliveryInbound.executeInboundTaskWithSessionQueue,
    deliverBotReplyText: deliveryInbound.deliverBotReplyText,
    recordInboundMetric: base.recordInboundMetric,
    recordRuntimeErrorMetric: base.recordRuntimeErrorMetric,
  });

  return {
    ...base,
    ...accountPolicy,
    ...deliveryInbound,
    markWecomReliableInboundActivity,
    recordReliableDeliveryOutcome,
    enqueueWecomPendingReply: pendingReplyManager.enqueuePendingReply,
    flushDueWecomPendingReplies: pendingReplyManager.flushDuePendingReplies,
    flushWecomSessionPendingReplies: pendingReplyManager.flushSessionPendingReplies,
    initializeWecomReliableDeliveryPersistence: async (api) => {
      pendingReplyApi = api ?? pendingReplyApi;
      await reliableDeliveryPersistence.ensureLoaded(api);
      await pendingReplyManager.initialize(api);
      return true;
    },
    persistWecomReliableDeliveryState: (reason = "manual", api) => reliableDeliveryPersistence.persistNow(reason, api),
    buildBotInboundContent,
    registerWecomDocTools,
    resetWecomConversationSession,
    clearSessionStoreEntry,
    setWecomBotLongConnectionInboundProcessor: wecomBotLongConnectionManager.setProcessBotInboundHandler,
    resolveWecomBotLongConnectionReplyContext: wecomBotLongConnectionManager.resolveReplyContext,
    pushWecomBotLongConnectionStreamUpdate: wecomBotLongConnectionManager.pushStreamUpdate,
    syncWecomBotLongConnections: wecomBotLongConnectionManager.sync,
    stopAllWecomBotLongConnections: wecomBotLongConnectionManager.stopAll,
    getWecomBotLongConnectionState: wecomBotLongConnectionManager.getConnectionState,
    ACTIVE_LATE_REPLY_WATCHERS,
    WECOM_TEMP_DIR_NAME,
    normalizePluginHttpPath,
    createWecomBotWebhookHandler,
    createWecomAgentWebhookHandler,
    pickAccountBySignature,
    decryptWecom,
    computeMsgSignature,
    parseWecomBotInboundMessage,
    describeWecomBotParsedMessage,
    markInboundMessageSeen,
    extractWecomXmlInboundEnvelope,
    buildWecomSessionId,
    buildInboundDedupeKey,
    resetInboundMessageDedupeForTests,
    splitWecomText,
    getByteLength,
    resolveWecomWebhookTargetConfig,
    buildMediaFetchErrorMessage,
    inferFilenameFromMediaDownload,
    smartDecryptWecomFileBuffer,
    buildWecomBotSessionId,
    normalizeWecomBotOutboundMediaUrls,
    shouldTriggerWecomGroupResponse,
    shouldStripWecomGroupMentions,
    stripWecomGroupMentions,
    isWecomSenderAllowed,
    extractLeadingSlashCommand,
    detectImageContentTypeFromBuffer,
    decryptWecomMediaBuffer,
    pickImageFileExtension,
    resolveWecomAgentRoute,
    resolveSessionTranscriptFilePath,
    readTranscriptAppendedChunk,
    parseLateAssistantReplyFromTranscriptLine,
    markdownToWecomText,
    sleep,
    withTimeout,
    isDispatchTimeoutError,
    isAgentFailureText,
    asNumber,
    requireEnv,
    writeFile,
    mkdir,
    tmpdir,
    join,
    basename,
  };
}
