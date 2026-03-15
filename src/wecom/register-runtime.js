import { analyzeWecomAccountConflicts } from "./account-diagnostics.js";

export function createWecomRegisterRuntime({
  setGatewayRuntime,
  syncWecomSessionQueuePolicy,
  resolveWecomDeliveryFallbackPolicy,
  resolveWecomWebhookBotDeliveryPolicy,
  resolveWecomObservabilityPolicy,
  resolveWecomDynamicAgentPolicy,
  resolveWecomBotConfig,
  resolveWecomBotConfigs,
  syncWecomBotLongConnections,
  initializeWecomReliableDeliveryPersistence,
  listEnabledWecomAccounts,
  getWecomConfig,
  wecomChannelPlugin,
  wecomRouteRegistrar,
  registerWecomDocTools,
} = {}) {
  if (typeof setGatewayRuntime !== "function") {
    throw new Error("createWecomRegisterRuntime: setGatewayRuntime is required");
  }
  if (typeof syncWecomSessionQueuePolicy !== "function") {
    throw new Error("createWecomRegisterRuntime: syncWecomSessionQueuePolicy is required");
  }
  if (typeof resolveWecomDeliveryFallbackPolicy !== "function") {
    throw new Error("createWecomRegisterRuntime: resolveWecomDeliveryFallbackPolicy is required");
  }
  if (typeof resolveWecomWebhookBotDeliveryPolicy !== "function") {
    throw new Error("createWecomRegisterRuntime: resolveWecomWebhookBotDeliveryPolicy is required");
  }
  if (typeof resolveWecomObservabilityPolicy !== "function") {
    throw new Error("createWecomRegisterRuntime: resolveWecomObservabilityPolicy is required");
  }
  if (typeof resolveWecomDynamicAgentPolicy !== "function") {
    throw new Error("createWecomRegisterRuntime: resolveWecomDynamicAgentPolicy is required");
  }
  if (typeof resolveWecomBotConfig !== "function") {
    throw new Error("createWecomRegisterRuntime: resolveWecomBotConfig is required");
  }
  if (resolveWecomBotConfigs != null && typeof resolveWecomBotConfigs !== "function") {
    throw new Error("createWecomRegisterRuntime: resolveWecomBotConfigs must be a function");
  }
  if (syncWecomBotLongConnections != null && typeof syncWecomBotLongConnections !== "function") {
    throw new Error("createWecomRegisterRuntime: syncWecomBotLongConnections must be a function");
  }
  if (
    initializeWecomReliableDeliveryPersistence != null &&
    typeof initializeWecomReliableDeliveryPersistence !== "function"
  ) {
    throw new Error("createWecomRegisterRuntime: initializeWecomReliableDeliveryPersistence must be a function");
  }
  if (listEnabledWecomAccounts != null && typeof listEnabledWecomAccounts !== "function") {
    throw new Error("createWecomRegisterRuntime: listEnabledWecomAccounts must be a function");
  }
  if (typeof getWecomConfig !== "function") {
    throw new Error("createWecomRegisterRuntime: getWecomConfig is required");
  }
  if (!wecomChannelPlugin || typeof wecomChannelPlugin !== "object") {
    throw new Error("createWecomRegisterRuntime: wecomChannelPlugin is required");
  }
  if (!wecomRouteRegistrar || typeof wecomRouteRegistrar !== "object") {
    throw new Error("createWecomRegisterRuntime: wecomRouteRegistrar is required");
  }
  if (registerWecomDocTools != null && typeof registerWecomDocTools !== "function") {
    throw new Error("createWecomRegisterRuntime: registerWecomDocTools must be a function");
  }

  function register(api) {
    setGatewayRuntime(api.runtime);
    void initializeWecomReliableDeliveryPersistence?.(api).catch((err) => {
      api.logger.warn?.(`wecom: failed to initialize reliable delivery persistence: ${String(err?.message || err)}`);
    });
    const streamManagerPolicy = syncWecomSessionQueuePolicy(api);
    const fallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const observabilityPolicy = resolveWecomObservabilityPolicy(api);
    const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);

    const botModeConfig = resolveWecomBotConfig(api);
    const botModeConfigs =
      typeof resolveWecomBotConfigs === "function"
        ? resolveWecomBotConfigs(api)
        : [botModeConfig];
    const enabledBotConfigs = (Array.isArray(botModeConfigs) ? botModeConfigs : []).filter((item) => item?.enabled === true);
    const cfg = getWecomConfig(api);
    if (cfg) {
      api.logger.info?.(
        `wecom: config loaded (corpId=${cfg.corpId?.slice(0, 8)}..., proxy=${cfg.outboundProxy ? "on" : "off"})`,
      );
    } else if (enabledBotConfigs.length > 0) {
      const webhookSummary = Array.from(
        new Set(enabledBotConfigs.map((item) => String(item?.webhookPath || "/wecom/bot/callback"))),
      ).join(", ");
      api.logger.info?.(
        `wecom(bot): config loaded (accounts=${enabledBotConfigs.length}, webhook=${webhookSummary}, streamExpireMs=${botModeConfig.streamExpireMs})`,
      );
    } else {
      api.logger.warn?.("wecom: no configuration found (check channels.wecom in openclaw.json)");
    }
    api.logger.info?.(
      `wecom: stream.manager ${streamManagerPolicy.enabled ? "on" : "off"} (timeoutMs=${streamManagerPolicy.timeoutMs}, perSession=${streamManagerPolicy.maxConcurrentPerSession})`,
    );
    api.logger.info?.(
      `wecom: delivery.fallback ${fallbackPolicy.enabled ? "on" : "off"} (order=${fallbackPolicy.order.join(">")})`,
    );
    if (webhookBotPolicy.enabled) {
      api.logger.info?.(
        `wecom: webhookBot fallback enabled (${webhookBotPolicy.url || webhookBotPolicy.key ? "configured" : "missing-url"})`,
      );
    }
    let longConnectionStarted = 0;
    if (typeof syncWecomBotLongConnections === "function") {
      const longConnectionResult = syncWecomBotLongConnections(api);
      longConnectionStarted = Number(longConnectionResult?.started) || 0;
      if (longConnectionStarted > 0) {
        api.logger.info?.(`wecom(bot-longconn): enabled accounts=${longConnectionStarted}`);
      }
    }
    if (observabilityPolicy.enabled) {
      api.logger.info?.(
        `wecom: observability enabled (payloadMeta=${observabilityPolicy.logPayloadMeta ? "on" : "off"})`,
      );
    }
    if (dynamicAgentPolicy.enabled) {
      api.logger.info?.(
        `wecom: dynamic-agent on (mode=${dynamicAgentPolicy.mode}, userMap=${Object.keys(dynamicAgentPolicy.userMap || {}).length}, groupMap=${Object.keys(dynamicAgentPolicy.groupMap || {}).length}, mentionMap=${Object.keys(dynamicAgentPolicy.mentionMap || {}).length})`,
      );
    }
    if (typeof listEnabledWecomAccounts === "function") {
      const accountDiagnostics = analyzeWecomAccountConflicts({
        accounts: listEnabledWecomAccounts(api),
        botConfigs: enabledBotConfigs,
      });
      for (const issue of accountDiagnostics.issues) {
        const line = `wecom: account diagnosis ${issue.code} ${issue.message}`;
        if (issue.severity === "warn") api.logger.warn?.(line);
        else api.logger.info?.(line);
      }
    }

    api.registerChannel({ plugin: wecomChannelPlugin });
    if (typeof registerWecomDocTools === "function") {
      registerWecomDocTools(api);
    }
    const botRouteRegistered = wecomRouteRegistrar.registerWecomBotWebhookRoute(api);
    const webhookGroups = wecomRouteRegistrar.registerWecomAgentWebhookRoutes(api);
    if (webhookGroups.size === 0 && !botRouteRegistered && longConnectionStarted === 0) {
      api.logger.warn?.("wecom: no enabled account with valid config found; webhook route not registered");
      return;
    }
  }

  return {
    register,
  };
}
