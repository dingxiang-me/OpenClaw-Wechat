function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new Error(`plugin-route-runtime-deps: ${name} is required`);
  }
}

export function createPluginRouteRuntimeDeps(context = {}) {
  assertObject("context", context);
  return {
    routeRegistrarDeps: {
      resolveWecomBotConfig: context.resolveWecomBotConfig,
      resolveWecomBotConfigs: context.resolveWecomBotConfigs,
      normalizePluginHttpPath: context.normalizePluginHttpPath,
      ensureBotStreamCleanupTimer: context.ensureBotStreamCleanupTimer,
      cleanupExpiredBotStreams: context.cleanupExpiredBotStreams,
      createWecomBotWebhookHandler: context.createWecomBotWebhookHandler,
      createWecomAgentWebhookHandler: context.createWecomAgentWebhookHandler,
      readRequestBody: context.readRequestBody,
      parseIncomingJson: context.parseIncomingJson,
      parseIncomingXml: context.parseIncomingXml,
      pickAccountBySignature: context.pickAccountBySignature,
      decryptWecom: context.decryptWecom,
      computeMsgSignature: context.computeMsgSignature,
      parseWecomBotInboundMessage: context.parseWecomBotInboundMessage,
      describeWecomBotParsedMessage: context.describeWecomBotParsedMessage,
      markInboundMessageSeen: context.markInboundMessageSeen,
      extractWecomXmlInboundEnvelope: context.extractWecomXmlInboundEnvelope,
      buildWecomSessionId: context.buildWecomSessionId,
      buildWecomBotSessionId: context.buildWecomBotSessionId,
      buildWecomBotEncryptedResponse: context.buildWecomBotEncryptedResponse,
      createBotStream: context.createBotStream,
      getBotStream: context.getBotStream,
      upsertBotResponseUrlCache: context.upsertBotResponseUrlCache,
      messageProcessLimiter: context.messageProcessLimiter,
      executeInboundTaskWithSessionQueue: context.executeInboundTaskWithSessionQueue,
      processBotInboundMessage: context.processBotInboundMessage,
      processInboundMessage: context.processInboundMessage,
      scheduleTextInboundProcessing: context.scheduleTextInboundProcessing,
      deliverBotReplyText: context.deliverBotReplyText,
      finishBotStream: context.finishBotStream,
      groupAccountsByWebhookPath: context.groupAccountsByWebhookPath,
    },
    registerRuntimeDeps: {
      setGatewayRuntime: context.setGatewayRuntime,
      syncWecomSessionQueuePolicy: context.syncWecomSessionQueuePolicy,
      resolveWecomDeliveryFallbackPolicy: context.resolveWecomDeliveryFallbackPolicy,
      resolveWecomWebhookBotDeliveryPolicy: context.resolveWecomWebhookBotDeliveryPolicy,
      resolveWecomObservabilityPolicy: context.resolveWecomObservabilityPolicy,
      resolveWecomDynamicAgentPolicy: context.resolveWecomDynamicAgentPolicy,
      resolveWecomBotConfig: context.resolveWecomBotConfig,
      resolveWecomBotConfigs: context.resolveWecomBotConfigs,
      getWecomConfig: context.getWecomConfig,
      wecomChannelPlugin: context.wecomChannelPlugin,
    },
  };
}
