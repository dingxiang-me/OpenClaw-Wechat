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
import { createWecomBotInboundContentBuilder } from "./bot-inbound-content.js";
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
  const base = createWecomPluginBaseServices({
    fetchImpl,
    proxyAgentCtor,
  });

  const accountPolicy = createWecomPluginAccountPolicyServices({
    processEnv,
    getGatewayRuntime: base.getGatewayRuntime,
    normalizeWecomResolvedTarget: base.normalizeWecomResolvedTarget,
    formatWecomTargetForLog: base.formatWecomTargetForLog,
    sendWecomWebhookText: base.sendWecomWebhookText,
    sendWecomWebhookMediaBatch: base.sendWecomWebhookMediaBatch,
    sendWecomOutboundMediaBatch: base.sendWecomOutboundMediaBatch,
    sendWecomText: base.sendWecomText,
  });

  const deliveryInbound = createWecomPluginDeliveryInboundServices({
    resolveWecomStreamManagerPolicy: accountPolicy.resolveWecomStreamManagerPolicy,
    setBotStreamExpireMs: base.setBotStreamExpireMs,
    attachWecomProxyDispatcher: base.attachWecomProxyDispatcher,
    resolveWecomDeliveryFallbackPolicy: accountPolicy.resolveWecomDeliveryFallbackPolicy,
    resolveWecomWebhookBotDeliveryPolicy: accountPolicy.resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomObservabilityPolicy: accountPolicy.resolveWecomObservabilityPolicy,
    resolveWecomBotProxyConfig: accountPolicy.resolveWecomBotProxyConfig,
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
    extractWorkspacePathsFromText: base.extractWorkspacePathsFromText,
    resolveWorkspacePathToHost: base.resolveWorkspacePathToHost,
    downloadWecomMedia: base.downloadWecomMedia,
    resolveWecomVoiceTranscriptionConfig: accountPolicy.resolveWecomVoiceTranscriptionConfig,
    transcribeInboundVoice: accountPolicy.transcribeInboundVoice,
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

  return {
    ...base,
    ...accountPolicy,
    ...deliveryInbound,
    buildBotInboundContent,
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
