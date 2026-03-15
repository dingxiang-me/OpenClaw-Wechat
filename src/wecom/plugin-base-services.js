import crypto from "node:crypto";
import { ProxyAgent } from "undici";
import {
  MAX_REQUEST_BODY_SIZE,
  PLUGIN_VERSION,
  TRANSCRIPT_REPLY_CACHE_TTL_MS,
  WECOM_MIN_FILE_SIZE,
  WECOM_TEMP_FILE_RETENTION_MS,
} from "./plugin-constants.js";
import { createWecomApiClient } from "./api-client.js";
import { createWecomBotStateStore } from "./bot-state-store.js";
import { createWecomBotEncryptedResponseBuilder } from "./bot-encrypted-response.js";
import { createWecomDefaultLimiters } from "./rate-limiter.js";
import { createWecomMediaFetcher, normalizeOutboundMediaUrls, resolveWecomOutboundMediaTarget } from "./media-url-utils.js";
import { createWecomOutboundSender } from "./outbound-sender.js";
import { createWecomObservabilityMetricsStore } from "./observability-metrics.js";
import { createWecomReliableDeliveryStore } from "./reliable-delivery.js";
import { createWecomRequestParsers } from "./request-parsers.js";
import { createWecomTargetResolver } from "./target-utils.js";
import { createDeliveredTranscriptReplyTracker } from "./transcript-utils.js";
import { createWorkspaceAutoSender, createTempFileCleanupScheduler } from "./workspace-tools.js";
import { sleep } from "./runtime-utils.js";
import { resolveWebhookBotSendUrl, webhookSendFileBuffer, webhookSendImage, webhookSendText } from "./webhook-bot.js";
import {
  buildMediaFetchErrorMessage,
  buildTinyFileFallbackText,
  extractWorkspacePathsFromText,
  resolveWorkspacePathToHost,
} from "./media-download.js";
import {
  computeMsgSignature,
  getByteLength,
  resolveWecomTarget,
  resolveWecomWebhookTargetConfig,
  splitWecomText,
} from "../core.js";
import { encryptWecomPayload as encryptWecom } from "./crypto-utils.js";

export function createWecomPluginBaseServices({
  fetchImpl = fetch,
  proxyAgentCtor = ProxyAgent,
} = {}) {
  const {
    recordInboundMetric,
    recordDeliveryMetric,
    recordRuntimeErrorMetric,
    getWecomObservabilityMetrics,
  } = createWecomObservabilityMetricsStore();
  const reliableDeliveryStore = createWecomReliableDeliveryStore();
  const { markTranscriptReplyDelivered, hasTranscriptReplyBeenDelivered } = createDeliveredTranscriptReplyTracker({
    ttlMs: TRANSCRIPT_REPLY_CACHE_TTL_MS,
  });
  const { scheduleTempFileCleanup } = createTempFileCleanupScheduler({
    defaultRetentionMs: WECOM_TEMP_FILE_RETENTION_MS,
  });

  const botStateStore = createWecomBotStateStore();
  const {
    setExpireMs: setBotStreamExpireMs,
    resolveActiveStream: resolveBotActiveStream,
    createStream: createBotStream,
    updateStream: updateBotStream,
    finishStream: finishBotStream,
    queueStreamMedia: queueBotStreamMedia,
    drainStreamMedia: drainBotStreamMedia,
    getStream: getBotStream,
    hasStream: hasBotStream,
    upsertResponseUrlCache: upsertBotResponseUrlCache,
    getResponseUrlCache: getBotResponseUrlCache,
    markResponseUrlUsed: markBotResponseUrlUsed,
    cleanupExpired: cleanupExpiredBotStreams,
    startCleanup: ensureBotStreamCleanupTimer,
  } = botStateStore;

  const { readRequestBody, parseIncomingXml, parseIncomingJson } = createWecomRequestParsers({
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
  });
  const { buildWecomBotEncryptedResponse } = createWecomBotEncryptedResponseBuilder({
    encryptWecom,
    computeMsgSignature,
  });
  const { apiLimiter, messageProcessLimiter } = createWecomDefaultLimiters();

  let gatewayRuntime = null;
  const getGatewayRuntime = () => gatewayRuntime;
  const setGatewayRuntime = (runtime) => {
    gatewayRuntime = runtime;
  };

  const {
    attachWecomProxyDispatcher,
    fetchWithRetry,
    getWecomAccessToken,
    buildWecomMessageSendRequest,
    sendWecomText,
    sendWecomMarkdown,
    uploadWecomMedia,
    sendWecomImage,
    sendWecomVideo,
    sendWecomFile,
    sendWecomVoice,
    downloadWecomMedia,
  } = createWecomApiClient({
    fetchImpl,
    proxyAgentCtor,
    sleep,
    splitWecomText,
    getByteLength,
    apiLimiter,
  });

  const { fetchMediaFromUrl } = createWecomMediaFetcher({
    fetchWithRetry,
    buildMediaFetchErrorMessage,
    pluginVersion: PLUGIN_VERSION,
  });

  const {
    sendWecomWebhookText,
    sendWecomWebhookMediaBatch,
    sendWecomOutboundMediaBatch,
  } = createWecomOutboundSender({
    resolveWecomWebhookTargetConfig,
    resolveWebhookBotSendUrl,
    attachWecomProxyDispatcher,
    splitWecomText,
    webhookSendText,
    webhookSendImage,
    webhookSendFileBuffer,
    fetchImpl,
    sleep,
    normalizeOutboundMediaUrls,
    resolveWecomOutboundMediaTarget,
    fetchMediaFromUrl,
    buildTinyFileFallbackText,
    sendWecomText,
    uploadWecomMedia,
    sendWecomImage,
    sendWecomVideo,
    sendWecomVoice,
    sendWecomFile,
    createHash: (algorithm, input) => crypto.createHash(algorithm).update(input).digest("hex"),
    minFileSize: WECOM_MIN_FILE_SIZE,
  });

  const { autoSendWorkspaceFilesFromReplyText } = createWorkspaceAutoSender({
    extractWorkspacePathsFromText,
    resolveWorkspacePathToHost,
    sendWecomOutboundMediaBatch,
  });

  const { normalizeWecomResolvedTarget, formatWecomTargetForLog } = createWecomTargetResolver({
    resolveWecomTarget,
  });

  function markWecomReliableInboundActivity({
    mode = "agent",
    accountId = "default",
    sessionId = "",
    fromUser = "",
    at,
  } = {}) {
    return reliableDeliveryStore.markInboundActivity({
      mode,
      accountId,
      sessionId,
      fromUser,
      at,
    });
  }

  function recordReliableDeliveryOutcome({
    mode = "agent",
    accountId = "default",
    sessionId = "",
    fromUser = "",
    deliveryStatus = "rejected_unknown",
    layer = "",
    reason = "",
    at,
  } = {}) {
    return reliableDeliveryStore.recordDeliveryOutcome({
      mode,
      accountId,
      sessionId,
      fromUser,
      deliveryStatus,
      layer,
      reason,
      at,
    });
  }

  function getWecomReliableDeliverySnapshot({
    mode = "agent",
    accountId = "default",
    sessionId = "",
  } = {}) {
    return reliableDeliveryStore.getDeliverySnapshot({
      mode,
      accountId,
      sessionId,
    });
  }

  return {
    markTranscriptReplyDelivered,
    hasTranscriptReplyBeenDelivered,
    recordInboundMetric,
    recordDeliveryMetric,
    recordRuntimeErrorMetric,
    getWecomObservabilityMetrics,
    markWecomReliableInboundActivity,
    recordReliableDeliveryOutcome,
    getWecomReliableDeliverySnapshot,
    reliableDeliveryStore,
    scheduleTempFileCleanup,
    setBotStreamExpireMs,
    resolveBotActiveStream,
    createBotStream,
    updateBotStream,
    finishBotStream,
    queueBotStreamMedia,
    drainBotStreamMedia,
    getBotStream,
    hasBotStream,
    upsertBotResponseUrlCache,
    getBotResponseUrlCache,
    markBotResponseUrlUsed,
    cleanupExpiredBotStreams,
    ensureBotStreamCleanupTimer,
    readRequestBody,
    parseIncomingXml,
    parseIncomingJson,
    buildWecomBotEncryptedResponse,
    apiLimiter,
    messageProcessLimiter,
    getGatewayRuntime,
    setGatewayRuntime,
    attachWecomProxyDispatcher,
    fetchWithRetry,
    getWecomAccessToken,
    buildWecomMessageSendRequest,
    sendWecomText,
    sendWecomMarkdown,
    uploadWecomMedia,
    sendWecomImage,
    sendWecomVideo,
    sendWecomFile,
    sendWecomVoice,
    downloadWecomMedia,
    fetchMediaFromUrl,
    sendWecomWebhookText,
    sendWecomWebhookMediaBatch,
    sendWecomOutboundMediaBatch,
    autoSendWorkspaceFilesFromReplyText,
    extractWorkspacePathsFromText,
    resolveWorkspacePathToHost,
    normalizeWecomResolvedTarget,
    formatWecomTargetForLog,
  };
}
