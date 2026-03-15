export function createWecomPolicyResolvers({
  getGatewayRuntime,
  normalizeAccountId,
  resolveWecomBotModeConfig,
  resolveWecomBotModeAccountsConfig,
  resolveWecomProxyConfig,
  resolveWecomCommandPolicyConfig,
  resolveWecomAllowFromPolicyConfig,
  resolveWecomDmPolicyConfig,
  resolveWecomEventPolicyConfig,
  resolveWecomGroupChatConfig,
  resolveWecomDebounceConfig,
  resolveWecomStreamingConfig,
  resolveWecomDeliveryFallbackConfig,
  resolveWecomPendingReplyConfig,
  resolveWecomQuotaTrackingConfig,
  resolveWecomReasoningConfig,
  resolveWecomReplyFormatConfig,
  resolveWecomWebhookBotDeliveryConfig,
  resolveWecomStreamManagerConfig,
  resolveWecomObservabilityConfig,
  resolveWecomDynamicAgentConfig,
  processEnv = process.env,
} = {}) {
  if (typeof getGatewayRuntime !== "function") {
    throw new Error("createWecomPolicyResolvers: getGatewayRuntime is required");
  }
  if (typeof normalizeAccountId !== "function") {
    throw new Error("createWecomPolicyResolvers: normalizeAccountId is required");
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function resolveLegacyInlineAccountConfig(channelConfig, normalizedAccountId) {
    const channel = asObject(channelConfig);
    for (const [key, value] of Object.entries(channel)) {
      if (normalizeAccountId(key) !== normalizedAccountId) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      return value;
    }
    return {};
  }

  function resolveRawWecomAccountConfig(channelConfig, normalizedAccountId) {
    if (normalizedAccountId === "default") return asObject(channelConfig);
    const rawChannel = asObject(channelConfig);
    const accountConfig = asObject(rawChannel?.accounts)?.[normalizedAccountId];
    if (accountConfig && typeof accountConfig === "object" && !Array.isArray(accountConfig)) {
      return accountConfig;
    }
    return resolveLegacyInlineAccountConfig(rawChannel, normalizedAccountId);
  }

  function resolveWecomPolicyAccountInputs(api, accountId = "default", accountConfig = {}) {
    const inputs = resolveWecomPolicyInputs(api);
    const normalizedAccountId = normalizeAccountId(accountId ?? accountConfig?.accountId ?? "default");
    const rawAccountConfig = resolveRawWecomAccountConfig(inputs.channelConfig, normalizedAccountId);
    return {
      ...inputs,
      accountId: normalizedAccountId,
      accountConfig: {
        ...rawAccountConfig,
        ...(accountConfig && typeof accountConfig === "object" ? accountConfig : {}),
      },
    };
  }

  function resolveWecomPolicyInputs(api) {
    const cfg = api?.config ?? getGatewayRuntime()?.config ?? {};
    return {
      channelConfig: cfg?.channels?.wecom ?? {},
      envVars: cfg?.env?.vars ?? {},
      processEnv,
    };
  }

  function resolveWecomBotConfigs(api) {
    const inputs = resolveWecomPolicyInputs(api);
    if (typeof resolveWecomBotModeAccountsConfig === "function") {
      return resolveWecomBotModeAccountsConfig(inputs);
    }
    return [resolveWecomBotModeConfig(inputs)];
  }

  function resolveWecomBotConfig(api, accountId = "default") {
    const normalizedAccountId = normalizeAccountId(accountId ?? "default");
    const configs = resolveWecomBotConfigs(api);
    const matched = configs.find((item) => normalizeAccountId(item?.accountId ?? "default") === normalizedAccountId);
    if (matched) return matched;
    if (normalizedAccountId !== "default") {
      const fallback = configs.find((item) => normalizeAccountId(item?.accountId ?? "default") === "default");
      if (fallback) return fallback;
    }
    return configs[0] ?? resolveWecomBotModeConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomBotProxyConfig(api, accountId = "default") {
    const inputs = resolveWecomPolicyInputs(api);
    const normalizedAccountId = normalizeAccountId(accountId ?? "default");
    const channelConfig = inputs.channelConfig ?? {};
    const accountConfig =
      normalizedAccountId === "default"
        ? channelConfig
        : channelConfig?.accounts && typeof channelConfig.accounts === "object"
          ? channelConfig.accounts[normalizedAccountId] ?? {}
          : {};
    const botConfig = accountConfig?.bot && typeof accountConfig.bot === "object" ? accountConfig.bot : {};
    const envVars = inputs.envVars ?? {};
    const processEnvVars = inputs.processEnv ?? process.env;
    const scopedBotProxyKey =
      normalizedAccountId === "default" ? null : `WECOM_${normalizedAccountId.toUpperCase()}_BOT_PROXY`;
    const scopedBotProxy = String(
      (scopedBotProxyKey ? envVars?.[scopedBotProxyKey] ?? processEnvVars?.[scopedBotProxyKey] : undefined) ??
        envVars?.WECOM_BOT_PROXY ??
        processEnvVars?.WECOM_BOT_PROXY ??
        "",
    ).trim();
    const fromBotConfig = String(botConfig?.outboundProxy ?? botConfig?.proxyUrl ?? botConfig?.proxy ?? "").trim();
    if (fromBotConfig) return fromBotConfig;
    if (scopedBotProxy) return scopedBotProxy;

    const proxyAccountConfig = {
      ...(accountConfig && typeof accountConfig === "object" ? accountConfig : {}),
      ...(botConfig && typeof botConfig === "object" ? botConfig : {}),
    };
    return resolveWecomProxyConfig({
      ...inputs,
      accountId: normalizedAccountId,
      accountConfig: proxyAccountConfig,
    });
  }

  function resolveWecomCommandPolicy(api) {
    return resolveWecomCommandPolicyConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomAllowFromPolicy(api, accountId, accountConfig = {}) {
    return resolveWecomAllowFromPolicyConfig(resolveWecomPolicyAccountInputs(api, accountId, accountConfig));
  }

  function resolveWecomDmPolicy(api, accountId, accountConfig = {}) {
    if (typeof resolveWecomDmPolicyConfig !== "function") {
      return { mode: "open", allowFrom: [], rejectMessage: "当前私聊账号未授权，请联系管理员。", enabled: false };
    }
    return resolveWecomDmPolicyConfig(resolveWecomPolicyAccountInputs(api, accountId, accountConfig));
  }

  function resolveWecomEventPolicy(api, accountId, accountConfig = {}) {
    if (typeof resolveWecomEventPolicyConfig !== "function") {
      return {
        enabled: true,
        enterAgentWelcomeEnabled: false,
        enterAgentWelcomeText: "你好，我是 AI 助手，直接发消息即可开始对话。",
      };
    }
    return resolveWecomEventPolicyConfig(resolveWecomPolicyAccountInputs(api, accountId, accountConfig));
  }

  function resolveWecomGroupChatPolicy(api, accountId = "default", accountConfig = {}, chatId = "") {
    return resolveWecomGroupChatConfig({
      ...resolveWecomPolicyAccountInputs(api, accountId, accountConfig),
      chatId,
    });
  }

  function resolveWecomTextDebouncePolicy(api) {
    return resolveWecomDebounceConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomReplyStreamingPolicy(api) {
    return resolveWecomStreamingConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomDeliveryFallbackPolicy(api) {
    return resolveWecomDeliveryFallbackConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomWebhookBotDeliveryPolicy(api) {
    return resolveWecomWebhookBotDeliveryConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomPendingReplyPolicy(api) {
    if (typeof resolveWecomPendingReplyConfig !== "function") {
      return {
        enabled: true,
        maxRetries: 3,
        retryBackoffMs: 15000,
        expireMs: 10 * 60 * 1000,
      };
    }
    return resolveWecomPendingReplyConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomQuotaTrackingPolicy(api) {
    if (typeof resolveWecomQuotaTrackingConfig !== "function") {
      return { enabled: true };
    }
    return resolveWecomQuotaTrackingConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomReasoningPolicy(api) {
    if (typeof resolveWecomReasoningConfig !== "function") {
      return {
        mode: "separate",
        sendThinkingMessage: true,
        includeInFinalAnswer: false,
        title: "思考过程",
        maxChars: 1200,
      };
    }
    return resolveWecomReasoningConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomReplyFormatPolicy(api) {
    if (typeof resolveWecomReplyFormatConfig !== "function") {
      return { mode: "auto" };
    }
    return resolveWecomReplyFormatConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomStreamManagerPolicy(api) {
    return resolveWecomStreamManagerConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomObservabilityPolicy(api) {
    return resolveWecomObservabilityConfig(resolveWecomPolicyInputs(api));
  }

  function resolveWecomDynamicAgentPolicy(api) {
    return resolveWecomDynamicAgentConfig(resolveWecomPolicyInputs(api));
  }

  return {
    resolveWecomPolicyInputs,
    resolveWecomBotConfigs,
    resolveWecomBotConfig,
    resolveWecomBotProxyConfig,
    resolveWecomCommandPolicy,
    resolveWecomAllowFromPolicy,
    resolveWecomDmPolicy,
    resolveWecomEventPolicy,
    resolveWecomGroupChatPolicy,
    resolveWecomTextDebouncePolicy,
    resolveWecomReplyStreamingPolicy,
    resolveWecomDeliveryFallbackPolicy,
    resolveWecomPendingReplyPolicy,
    resolveWecomQuotaTrackingPolicy,
    resolveWecomReasoningPolicy,
    resolveWecomReplyFormatPolicy,
    resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomStreamManagerPolicy,
    resolveWecomObservabilityPolicy,
    resolveWecomDynamicAgentPolicy,
  };
}
