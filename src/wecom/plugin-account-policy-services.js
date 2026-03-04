import { WECOM_TEMP_DIR_NAME, PLUGIN_VERSION } from "./plugin-constants.js";
import { createWecomAccountRegistry } from "./account-config.js";
import { createWecomAccountRuntime } from "./account-runtime.js";
import { createWecomChannelPlugin } from "./channel-plugin.js";
import { createWecomCommandHandlers } from "./command-handlers.js";
import { createWecomPolicyResolvers } from "./policy-resolvers.js";
import { createWecomVoiceTranscriber } from "./voice-transcription.js";
import {
  isLocalVoiceInputTypeDirectlySupported,
  normalizeAudioContentType,
  normalizeWecomWebhookTargetMap,
  pickAudioFileExtension,
  resolveVoiceTranscriptionConfig,
  resolveWecomAllowFromPolicyConfig,
  resolveWecomBotModeAccountsConfig,
  resolveWecomBotModeConfig,
  resolveWecomCommandPolicyConfig,
  resolveWecomDebounceConfig,
  resolveWecomDeliveryFallbackConfig,
  resolveWecomDynamicAgentConfig,
  resolveWecomGroupChatConfig,
  resolveWecomObservabilityConfig,
  resolveWecomProxyConfig,
  resolveWecomStreamManagerConfig,
  resolveWecomStreamingConfig,
  resolveWecomWebhookBotDeliveryConfig,
} from "../core.js";

export function createWecomPluginAccountPolicyServices({
  processEnv = process.env,
  getGatewayRuntime,
  normalizeWecomResolvedTarget,
  formatWecomTargetForLog,
  sendWecomWebhookText,
  sendWecomWebhookMediaBatch,
  sendWecomOutboundMediaBatch,
  sendWecomText,
} = {}) {
  const wecomAccountRegistry = createWecomAccountRegistry({
    normalizeWecomWebhookTargetMap,
    resolveWecomProxyConfig,
    processEnv,
  });

  const {
    normalizeAccountId,
    getWecomConfig,
    listWecomAccountIds,
    listWebhookTargetAliases,
    listAllWebhookTargetAliases,
    groupAccountsByWebhookPath,
  } = createWecomAccountRuntime({
    wecomAccountRegistry,
    getGatewayRuntime,
  });

  const WecomChannelPlugin = createWecomChannelPlugin({
    listWecomAccountIds,
    getWecomConfig,
    getGatewayRuntime,
    normalizeWecomResolvedTarget,
    formatWecomTargetForLog,
    sendWecomWebhookText,
    sendWecomWebhookMediaBatch,
    sendWecomOutboundMediaBatch,
    sendWecomText,
  });

  const {
    resolveWecomBotConfigs,
    resolveWecomBotConfig,
    resolveWecomBotProxyConfig,
    resolveWecomCommandPolicy,
    resolveWecomAllowFromPolicy,
    resolveWecomGroupChatPolicy,
    resolveWecomTextDebouncePolicy,
    resolveWecomReplyStreamingPolicy,
    resolveWecomDeliveryFallbackPolicy,
    resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomStreamManagerPolicy,
    resolveWecomObservabilityPolicy,
    resolveWecomDynamicAgentPolicy,
  } = createWecomPolicyResolvers({
    getGatewayRuntime,
    normalizeAccountId,
    resolveWecomBotModeConfig,
    resolveWecomBotModeAccountsConfig,
    resolveWecomProxyConfig,
    resolveWecomCommandPolicyConfig,
    resolveWecomAllowFromPolicyConfig,
    resolveWecomGroupChatConfig,
    resolveWecomDebounceConfig,
    resolveWecomStreamingConfig,
    resolveWecomDeliveryFallbackConfig,
    resolveWecomWebhookBotDeliveryConfig,
    resolveWecomStreamManagerConfig,
    resolveWecomObservabilityConfig,
    resolveWecomDynamicAgentConfig,
    processEnv,
  });

  const { resolveWecomVoiceTranscriptionConfig, transcribeInboundVoice } = createWecomVoiceTranscriber({
    tempDirName: WECOM_TEMP_DIR_NAME,
    resolveVoiceTranscriptionConfig,
    normalizeAudioContentType,
    isLocalVoiceInputTypeDirectlySupported,
    pickAudioFileExtension,
    processEnv,
  });

  const { COMMANDS, buildWecomBotHelpText, buildWecomBotStatusText } = createWecomCommandHandlers({
    sendWecomText,
    getWecomConfig,
    listWecomAccountIds,
    listWebhookTargetAliases,
    listAllWebhookTargetAliases,
    resolveWecomVoiceTranscriptionConfig,
    resolveWecomCommandPolicy,
    resolveWecomAllowFromPolicy,
    resolveWecomGroupChatPolicy,
    resolveWecomTextDebouncePolicy,
    resolveWecomReplyStreamingPolicy,
    resolveWecomDeliveryFallbackPolicy,
    resolveWecomStreamManagerPolicy,
    resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomDynamicAgentPolicy,
    resolveWecomBotConfig,
    pluginVersion: PLUGIN_VERSION,
  });

  return {
    normalizeAccountId,
    getWecomConfig,
    listWecomAccountIds,
    listWebhookTargetAliases,
    listAllWebhookTargetAliases,
    groupAccountsByWebhookPath,
    WecomChannelPlugin,
    resolveWecomBotConfig,
    resolveWecomBotConfigs,
    resolveWecomBotProxyConfig,
    resolveWecomCommandPolicy,
    resolveWecomAllowFromPolicy,
    resolveWecomGroupChatPolicy,
    resolveWecomTextDebouncePolicy,
    resolveWecomReplyStreamingPolicy,
    resolveWecomDeliveryFallbackPolicy,
    resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomStreamManagerPolicy,
    resolveWecomObservabilityPolicy,
    resolveWecomDynamicAgentPolicy,
    resolveWecomVoiceTranscriptionConfig,
    transcribeInboundVoice,
    COMMANDS,
    buildWecomBotHelpText,
    buildWecomBotStatusText,
  };
}
