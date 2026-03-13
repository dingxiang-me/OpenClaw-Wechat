import { buildAgentStatusText, buildBotStatusText, buildWecomBotHelpText } from "./command-status-text.js";

export function createWecomCommandHandlers({
  sendWecomText,
  getWecomConfig,
  listWecomAccountIds,
  listWebhookTargetAliases,
  listAllWebhookTargetAliases,
  resolveWecomVoiceTranscriptionConfig,
  inspectWecomVoiceTranscriptionRuntime = async () => null,
  resolveWecomCommandPolicy,
  resolveWecomAllowFromPolicy,
  resolveWecomDmPolicy,
  resolveWecomEventPolicy = () => ({
    enabled: true,
    enterAgentWelcomeEnabled: false,
    enterAgentWelcomeText: "",
  }),
  resolveWecomGroupChatPolicy,
  resolveWecomTextDebouncePolicy,
  resolveWecomReplyStreamingPolicy,
  resolveWecomDeliveryFallbackPolicy,
  resolveWecomStreamManagerPolicy,
  resolveWecomWebhookBotDeliveryPolicy,
  resolveWecomDynamicAgentPolicy,
  resolveWecomBotConfig,
  getWecomObservabilityMetrics = () => ({}),
  pluginVersion,
} = {}) {
  if (typeof sendWecomText !== "function") throw new Error("createWecomCommandHandlers: sendWecomText is required");
  if (typeof getWecomConfig !== "function") throw new Error("createWecomCommandHandlers: getWecomConfig is required");
  if (typeof listWecomAccountIds !== "function") throw new Error("createWecomCommandHandlers: listWecomAccountIds is required");
  if (typeof listWebhookTargetAliases !== "function") {
    throw new Error("createWecomCommandHandlers: listWebhookTargetAliases is required");
  }
  if (typeof listAllWebhookTargetAliases !== "function") {
    throw new Error("createWecomCommandHandlers: listAllWebhookTargetAliases is required");
  }
  if (typeof resolveWecomVoiceTranscriptionConfig !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomVoiceTranscriptionConfig is required");
  }
  if (typeof inspectWecomVoiceTranscriptionRuntime !== "function") {
    throw new Error("createWecomCommandHandlers: inspectWecomVoiceTranscriptionRuntime is required");
  }
  if (typeof resolveWecomCommandPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomCommandPolicy is required");
  }
  if (typeof resolveWecomAllowFromPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomAllowFromPolicy is required");
  }
  if (typeof resolveWecomDmPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomDmPolicy is required");
  }
  if (typeof resolveWecomEventPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomEventPolicy is required");
  }
  if (typeof resolveWecomGroupChatPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomGroupChatPolicy is required");
  }
  if (typeof resolveWecomTextDebouncePolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomTextDebouncePolicy is required");
  }
  if (typeof resolveWecomReplyStreamingPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomReplyStreamingPolicy is required");
  }
  if (typeof resolveWecomDeliveryFallbackPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomDeliveryFallbackPolicy is required");
  }
  if (typeof resolveWecomStreamManagerPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomStreamManagerPolicy is required");
  }
  if (typeof resolveWecomWebhookBotDeliveryPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomWebhookBotDeliveryPolicy is required");
  }
  if (typeof resolveWecomDynamicAgentPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomDynamicAgentPolicy is required");
  }
  if (typeof resolveWecomBotConfig !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomBotConfig is required");
  }

  async function handleHelpCommand({ api, fromUser, corpId, corpSecret, agentId, proxyUrl, apiProxy }) {
    const helpText = `🤖 AI 助手使用帮助

可用命令：
/help - 显示此帮助信息
/new - 新建会话（兼容命令，等价于 /reset）
/clear - 重置会话（等价于 /reset）
/status - 查看系统状态

直接发送消息即可与 AI 对话。
支持发送图片，AI 会分析图片内容。`;

    await sendWecomText({
      corpId,
      corpSecret,
      agentId,
      toUser: fromUser,
      text: helpText,
      proxyUrl,
      apiProxy,
      logger: api.logger,
    });
    return true;
  }

  async function handleStatusCommand({ api, fromUser, corpId, corpSecret, agentId, accountId, proxyUrl, apiProxy }) {
    const config = getWecomConfig(api, accountId);
    const accountIds = listWecomAccountIds(api);
    const webhookTargetAliases = listWebhookTargetAliases(config);
    const voiceConfig = resolveWecomVoiceTranscriptionConfig(api);
    const voiceRuntimeInfo = await inspectWecomVoiceTranscriptionRuntime({ api, voiceConfig });
    const commandPolicy = resolveWecomCommandPolicy(api);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, config?.accountId, config);
    const dmPolicy = resolveWecomDmPolicy(api, config?.accountId, config);
    const eventPolicy = resolveWecomEventPolicy(api, config?.accountId, config);
    const groupPolicy = resolveWecomGroupChatPolicy(api);
    const debouncePolicy = resolveWecomTextDebouncePolicy(api);
    const streamingPolicy = resolveWecomReplyStreamingPolicy(api);
    const deliveryFallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const streamManagerPolicy = resolveWecomStreamManagerPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
    const observabilityMetrics = getWecomObservabilityMetrics();

    const statusText = buildAgentStatusText({
      fromUser,
      config,
      accountIds,
      webhookTargetAliases,
      pluginVersion,
      voiceConfig,
      voiceRuntimeInfo,
      commandPolicy,
      allowFromPolicy,
      dmPolicy,
      eventPolicy,
      groupPolicy,
      debouncePolicy,
      streamingPolicy,
      deliveryFallbackPolicy,
      streamManagerPolicy,
      webhookBotPolicy,
      dynamicAgentPolicy,
      observabilityMetrics,
    });

    await sendWecomText({
      corpId,
      corpSecret,
      agentId,
      toUser: fromUser,
      text: statusText,
      logger: api.logger,
      proxyUrl,
      apiProxy,
    });
    return true;
  }

  function buildBotStatus(api, fromUser) {
    const allWebhookTargetAliases = listAllWebhookTargetAliases(api);
    const commandPolicy = resolveWecomCommandPolicy(api);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, "default", {});
    const dmPolicy = resolveWecomDmPolicy(api, "default", {});
    const eventPolicy = resolveWecomEventPolicy(api, "default", {});
    const groupPolicy = resolveWecomGroupChatPolicy(api);
    const botConfig = resolveWecomBotConfig(api);
    const deliveryFallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const streamManagerPolicy = resolveWecomStreamManagerPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
    const observabilityMetrics = getWecomObservabilityMetrics();
    return buildBotStatusText({
      fromUser,
      pluginVersion,
      botConfig,
      allWebhookTargetAliases,
      commandPolicy,
      allowFromPolicy,
      dmPolicy,
      eventPolicy,
      groupPolicy,
      deliveryFallbackPolicy,
      streamManagerPolicy,
      webhookBotPolicy,
      dynamicAgentPolicy,
      observabilityMetrics,
    });
  }

  return {
    COMMANDS: {
      "/help": handleHelpCommand,
      "/status": handleStatusCommand,
    },
    buildWecomBotHelpText,
    buildWecomBotStatusText: buildBotStatus,
  };
}
