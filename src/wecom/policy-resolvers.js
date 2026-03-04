export function createWecomPolicyResolvers({
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
  processEnv = process.env,
} = {}) {
  if (typeof getGatewayRuntime !== "function") {
    throw new Error("createWecomPolicyResolvers: getGatewayRuntime is required");
  }
  if (typeof normalizeAccountId !== "function") {
    throw new Error("createWecomPolicyResolvers: normalizeAccountId is required");
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
    const inputs = resolveWecomPolicyInputs(api);
    return resolveWecomAllowFromPolicyConfig({
      ...inputs,
      accountId: normalizeAccountId(accountId ?? "default"),
      accountConfig: accountConfig ?? {},
    });
  }

  function resolveWecomGroupChatPolicy(api) {
    return resolveWecomGroupChatConfig(resolveWecomPolicyInputs(api));
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
    resolveWecomGroupChatPolicy,
    resolveWecomTextDebouncePolicy,
    resolveWecomReplyStreamingPolicy,
    resolveWecomDeliveryFallbackPolicy,
    resolveWecomWebhookBotDeliveryPolicy,
    resolveWecomStreamManagerPolicy,
    resolveWecomObservabilityPolicy,
    resolveWecomDynamicAgentPolicy,
  };
}
