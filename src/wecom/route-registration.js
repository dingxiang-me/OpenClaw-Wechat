export function createWecomRouteRegistrar({
  resolveWecomBotConfig,
  resolveWecomBotConfigs,
  normalizePluginHttpPath,
  ensureBotStreamCleanupTimer,
  cleanupExpiredBotStreams,
  createWecomBotWebhookHandler,
  createWecomAgentWebhookHandler,
  readRequestBody,
  parseIncomingJson,
  parseIncomingXml,
  pickAccountBySignature,
  decryptWecom,
  computeMsgSignature,
  parseWecomBotInboundMessage,
  describeWecomBotParsedMessage,
  markInboundMessageSeen,
  extractWecomXmlInboundEnvelope,
  buildWecomSessionId,
  buildWecomBotSessionId,
  buildWecomBotEncryptedResponse,
  createBotStream,
  getBotStream,
  upsertBotResponseUrlCache,
  messageProcessLimiter,
  executeInboundTaskWithSessionQueue,
  processBotInboundMessage,
  processInboundMessage,
  scheduleTextInboundProcessing,
  deliverBotReplyText,
  finishBotStream,
  groupAccountsByWebhookPath,
} = {}) {
  if (typeof resolveWecomBotConfig !== "function") throw new Error("createWecomRouteRegistrar: resolveWecomBotConfig is required");
  if (typeof resolveWecomBotConfigs !== "function") {
    throw new Error("createWecomRouteRegistrar: resolveWecomBotConfigs is required");
  }
  if (typeof normalizePluginHttpPath !== "function") {
    throw new Error("createWecomRouteRegistrar: normalizePluginHttpPath is required");
  }
  if (typeof ensureBotStreamCleanupTimer !== "function") {
    throw new Error("createWecomRouteRegistrar: ensureBotStreamCleanupTimer is required");
  }
  if (typeof cleanupExpiredBotStreams !== "function") {
    throw new Error("createWecomRouteRegistrar: cleanupExpiredBotStreams is required");
  }
  if (typeof createWecomBotWebhookHandler !== "function") {
    throw new Error("createWecomRouteRegistrar: createWecomBotWebhookHandler is required");
  }
  if (typeof createWecomAgentWebhookHandler !== "function") {
    throw new Error("createWecomRouteRegistrar: createWecomAgentWebhookHandler is required");
  }
  if (typeof groupAccountsByWebhookPath !== "function") {
    throw new Error("createWecomRouteRegistrar: groupAccountsByWebhookPath is required");
  }

  function registerWecomBotWebhookRoute(api) {
    const botConfigs = resolveWecomBotConfigs(api);
    const enabledBotConfigs = (Array.isArray(botConfigs) ? botConfigs : []).filter((item) => item?.enabled === true);
    if (enabledBotConfigs.length === 0) return false;

    const signedBotConfigs = enabledBotConfigs.filter((item) => item?.token && item?.encodingAesKey);
    if (signedBotConfigs.length === 0) {
      api.logger.warn?.("wecom(bot): enabled but missing token/encodingAesKey; route not registered");
      return false;
    }

    const grouped = new Map();
    for (const botConfig of signedBotConfigs) {
      const normalizedPath =
        normalizePluginHttpPath(botConfig.webhookPath ?? "/wecom/bot/callback", "/wecom/bot/callback") ??
        "/wecom/bot/callback";
      const existing = grouped.get(normalizedPath);
      if (existing) existing.push(botConfig);
      else grouped.set(normalizedPath, [botConfig]);
    }

    let registeredCount = 0;
    for (const [normalizedPath, pathConfigs] of grouped.entries()) {
      const maxStreamExpireMs = pathConfigs.reduce(
        (acc, item) => Math.max(acc, Number(item?.streamExpireMs) || 0),
        0,
      );
      ensureBotStreamCleanupTimer(maxStreamExpireMs || 600000, api.logger);
      cleanupExpiredBotStreams(maxStreamExpireMs || 600000);

      const handler = createWecomBotWebhookHandler({
        api,
        botConfigs: pathConfigs,
        normalizedPath,
        readRequestBody,
        parseIncomingJson,
        computeMsgSignature,
        decryptWecom,
        parseWecomBotInboundMessage,
        describeWecomBotParsedMessage,
        cleanupExpiredBotStreams,
        getBotStream,
        buildWecomBotEncryptedResponse,
        markInboundMessageSeen,
        buildWecomBotSessionId,
        createBotStream,
        upsertBotResponseUrlCache,
        messageProcessLimiter,
        executeInboundTaskWithSessionQueue,
        processBotInboundMessage,
        deliverBotReplyText,
        finishBotStream,
      });

      api.registerHttpRoute({
        path: normalizedPath,
        auth: "plugin",
        handler,
      });

      const accountIds = pathConfigs.map((item) => String(item?.accountId ?? "default")).join(", ");
      api.logger.info?.(`wecom(bot): registered webhook at ${normalizedPath} (accounts=${accountIds})`);
      registeredCount += 1;
    }
    return registeredCount > 0;
  }

  function registerWecomAgentWebhookRoutes(api) {
    const webhookGroups = groupAccountsByWebhookPath(api);
    for (const [normalizedPath, accounts] of webhookGroups.entries()) {
      const handler = createWecomAgentWebhookHandler({
        api,
        accounts,
        readRequestBody,
        parseIncomingXml,
        pickAccountBySignature,
        decryptWecom,
        markInboundMessageSeen,
        extractWecomXmlInboundEnvelope,
        buildWecomSessionId,
        scheduleTextInboundProcessing,
        messageProcessLimiter,
        executeInboundTaskWithSessionQueue,
        processInboundMessage,
      });
      api.registerHttpRoute({
        path: normalizedPath,
        auth: "plugin",
        handler,
      });

      const accountIds = accounts.map((a) => a.accountId).join(", ");
      api.logger.info?.(`wecom: registered webhook at ${normalizedPath} (accounts=${accountIds})`);
    }
    return webhookGroups;
  }

  return {
    registerWecomBotWebhookRoute,
    registerWecomAgentWebhookRoutes,
  };
}
