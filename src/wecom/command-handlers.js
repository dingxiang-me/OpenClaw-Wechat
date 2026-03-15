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
  resolveWecomPendingReplyPolicy,
  resolveWecomQuotaTrackingPolicy,
  resolveWecomReasoningPolicy,
  resolveWecomReplyFormatPolicy,
  resolveWecomStreamManagerPolicy,
  resolveWecomWebhookBotDeliveryPolicy,
  resolveWecomDynamicAgentPolicy,
  resolveWecomBotConfig,
  buildWecomSessionId,
  buildWecomBotSessionId,
  getWecomReliableDeliverySnapshot = () => null,
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
  if (typeof resolveWecomPendingReplyPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomPendingReplyPolicy is required");
  }
  if (typeof resolveWecomQuotaTrackingPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomQuotaTrackingPolicy is required");
  }
  if (typeof resolveWecomReasoningPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomReasoningPolicy is required");
  }
  if (typeof resolveWecomReplyFormatPolicy !== "function") {
    throw new Error("createWecomCommandHandlers: resolveWecomReplyFormatPolicy is required");
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
  if (typeof buildWecomSessionId !== "function") {
    throw new Error("createWecomCommandHandlers: buildWecomSessionId is required");
  }
  if (typeof buildWecomBotSessionId !== "function") {
    throw new Error("createWecomCommandHandlers: buildWecomBotSessionId is required");
  }

  async function handleHelpCommand({ api, fromUser, corpId, corpSecret, agentId, proxyUrl, apiBaseUrl }) {
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
      apiBaseUrl,
      logger: api.logger,
    });
    return true;
  }

  async function handleStatusCommand({
    api,
    fromUser,
    corpId,
    corpSecret,
    agentId,
    accountId,
    proxyUrl,
    apiBaseUrl,
    chatId = "",
    isGroupChat = false,
  }) {
    const config = getWecomConfig(api, accountId);
    const accountIds = listWecomAccountIds(api);
    const bindingsCount = Array.isArray(api?.config?.bindings) ? api.config.bindings.length : 0;
    const webhookTargetAliases = listWebhookTargetAliases(config);
    const voiceConfig = resolveWecomVoiceTranscriptionConfig(api);
    const voiceRuntimeInfo = await inspectWecomVoiceTranscriptionRuntime({ api, voiceConfig });
    const commandPolicy = resolveWecomCommandPolicy(api);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, config?.accountId, config);
    const dmPolicy = resolveWecomDmPolicy(api, config?.accountId, config);
    const eventPolicy = resolveWecomEventPolicy(api, config?.accountId, config);
    const groupPolicy = resolveWecomGroupChatPolicy(
      api,
      config?.accountId || accountId || "default",
      config,
      isGroupChat ? chatId : "",
    );
    const debouncePolicy = resolveWecomTextDebouncePolicy(api);
    const streamingPolicy = resolveWecomReplyStreamingPolicy(api);
    const deliveryFallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const pendingReplyPolicy = resolveWecomPendingReplyPolicy(api);
    const quotaTrackingPolicy = resolveWecomQuotaTrackingPolicy(api);
    const reasoningPolicy = resolveWecomReasoningPolicy(api);
    const replyFormatPolicy = resolveWecomReplyFormatPolicy(api);
    const streamManagerPolicy = resolveWecomStreamManagerPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
    const observabilityMetrics = getWecomObservabilityMetrics();
    const reliableDeliverySnapshot = getWecomReliableDeliverySnapshot({
      mode: "agent",
      accountId: config?.accountId || accountId || "default",
      sessionId: buildWecomSessionId(fromUser, config?.accountId || accountId || "default"),
    });

    const statusText = buildAgentStatusText({
      fromUser,
      accountId: config?.accountId || accountId || "default",
      chatId,
      isGroupChat,
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
      pendingReplyPolicy,
      quotaTrackingPolicy,
      reasoningPolicy,
      replyFormatPolicy,
      streamManagerPolicy,
      webhookBotPolicy,
      dynamicAgentPolicy,
      observabilityMetrics,
      bindingsCount,
      reliableDeliverySnapshot,
    });

    await sendWecomText({
      corpId,
      corpSecret,
      agentId,
      toUser: fromUser,
      text: statusText,
      logger: api.logger,
      proxyUrl,
      apiBaseUrl,
    });
    return true;
  }

  function buildBotStatus(api, fromUser, context = {}) {
    const normalizedAccountId = String(context?.accountId ?? "default").trim().toLowerCase() || "default";
    const allWebhookTargetAliases = listAllWebhookTargetAliases(api);
    const config = getWecomConfig(api, normalizedAccountId);
    const bindingsCount = Array.isArray(api?.config?.bindings) ? api.config.bindings.length : 0;
    const commandPolicy = resolveWecomCommandPolicy(api);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, normalizedAccountId, config);
    const dmPolicy = resolveWecomDmPolicy(api, normalizedAccountId, config);
    const eventPolicy = resolveWecomEventPolicy(api, normalizedAccountId, config);
    const groupPolicy = resolveWecomGroupChatPolicy(
      api,
      normalizedAccountId,
      config,
      context?.isGroupChat ? context?.chatId : "",
    );
    const botConfig = resolveWecomBotConfig(api, normalizedAccountId);
    const deliveryFallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const pendingReplyPolicy = resolveWecomPendingReplyPolicy(api);
    const quotaTrackingPolicy = resolveWecomQuotaTrackingPolicy(api);
    const reasoningPolicy = resolveWecomReasoningPolicy(api);
    const replyFormatPolicy = resolveWecomReplyFormatPolicy(api);
    const streamManagerPolicy = resolveWecomStreamManagerPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
    const observabilityMetrics = getWecomObservabilityMetrics();
    const reliableDeliverySnapshot = getWecomReliableDeliverySnapshot({
      mode: "bot",
      accountId: normalizedAccountId,
      sessionId: buildWecomBotSessionId(fromUser, normalizedAccountId),
    });
    return buildBotStatusText({
      fromUser,
      accountId: normalizedAccountId,
      chatId: context?.chatId || "",
      isGroupChat: context?.isGroupChat === true,
      pluginVersion,
      botConfig,
      allWebhookTargetAliases,
      commandPolicy,
      allowFromPolicy,
      dmPolicy,
      eventPolicy,
      groupPolicy,
      deliveryFallbackPolicy,
      pendingReplyPolicy,
      quotaTrackingPolicy,
      reasoningPolicy,
      replyFormatPolicy,
      streamManagerPolicy,
      webhookBotPolicy,
      dynamicAgentPolicy,
      observabilityMetrics,
      config,
      bindingsCount,
      reliableDeliverySnapshot,
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
