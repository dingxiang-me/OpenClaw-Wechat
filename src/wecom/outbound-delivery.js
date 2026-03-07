import { createWecomDeliveryRouter, parseWecomResponseUrlResult } from "../core/delivery-router.js";
import { buildWecomBotMixedPayload, normalizeWecomBotOutboundMediaUrls } from "./webhook-adapter.js";
import { resolveWecomOutboundMediaTarget } from "./media-url-utils.js";
import { createWecomActiveStreamDeliverer } from "./outbound-active-stream.js";
import { createWecomAgentPushDeliverer } from "./outbound-agent-push.js";
import { createWecomResponseUrlDeliverer } from "./outbound-response-delivery.js";
import { createWecomResponseUrlSender } from "./outbound-response-url.js";
import { createWecomWebhookBotDeliverer } from "./outbound-webhook-delivery.js";
import { createWecomWebhookBotMediaSender } from "./outbound-webhook-media.js";
import { buildActiveStreamMsgItems } from "./outbound-stream-msg-item.js";
import { buildWecomBotCardPayload } from "./outbound-bot-card.js";
import {
  resolveWebhookBotSendUrl,
  webhookSendFileBuffer,
  webhookSendImage,
  webhookSendMarkdown,
  webhookSendTemplateCard,
  webhookSendText,
} from "./webhook-bot.js";
import { stat } from "node:fs/promises";

function assertFunction(name, fn) {
  if (typeof fn !== "function") {
    throw new Error(`createWecomBotReplyDeliverer missing function dependency: ${name}`);
  }
}

export function createWecomBotReplyDeliverer({
  attachWecomProxyDispatcher,
  resolveWecomDeliveryFallbackPolicy,
  resolveWecomWebhookBotDeliveryPolicy,
  resolveWecomObservabilityPolicy,
  resolveWecomBotProxyConfig,
  resolveWecomBotConfig,
  buildWecomBotSessionId,
  upsertBotResponseUrlCache,
  getBotResponseUrlCache,
  markBotResponseUrlUsed,
  createDeliveryTraceId,
  hasBotStream,
  resolveActiveBotStreamId = () => "",
  finishBotStream,
  drainBotStreamMedia = () => [],
  getWecomConfig,
  sendWecomText,
  fetchMediaFromUrl,
  resolveWebhookBotSendUrlFn = resolveWebhookBotSendUrl,
  webhookSendTextFn = webhookSendText,
  webhookSendImageFn = webhookSendImage,
  webhookSendFileBufferFn = webhookSendFileBuffer,
  extractWorkspacePathsFromText = () => [],
  resolveWorkspacePathToHost = () => "",
  recordDeliveryMetric = () => {},
  statImpl = stat,
  fetchImpl = fetch,
} = {}) {
  assertFunction("attachWecomProxyDispatcher", attachWecomProxyDispatcher);
  assertFunction("resolveWecomDeliveryFallbackPolicy", resolveWecomDeliveryFallbackPolicy);
  assertFunction("resolveWecomWebhookBotDeliveryPolicy", resolveWecomWebhookBotDeliveryPolicy);
  assertFunction("resolveWecomObservabilityPolicy", resolveWecomObservabilityPolicy);
  assertFunction("resolveWecomBotProxyConfig", resolveWecomBotProxyConfig);
  assertFunction("resolveWecomBotConfig", resolveWecomBotConfig);
  assertFunction("buildWecomBotSessionId", buildWecomBotSessionId);
  assertFunction("upsertBotResponseUrlCache", upsertBotResponseUrlCache);
  assertFunction("getBotResponseUrlCache", getBotResponseUrlCache);
  assertFunction("markBotResponseUrlUsed", markBotResponseUrlUsed);
  assertFunction("createDeliveryTraceId", createDeliveryTraceId);
  assertFunction("hasBotStream", hasBotStream);
  assertFunction("resolveActiveBotStreamId", resolveActiveBotStreamId);
  assertFunction("finishBotStream", finishBotStream);
  assertFunction("drainBotStreamMedia", drainBotStreamMedia);
  assertFunction("getWecomConfig", getWecomConfig);
  assertFunction("sendWecomText", sendWecomText);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("resolveWebhookBotSendUrlFn", resolveWebhookBotSendUrlFn);
  assertFunction("webhookSendTextFn", webhookSendTextFn);
  assertFunction("webhookSendImageFn", webhookSendImageFn);
  assertFunction("webhookSendFileBufferFn", webhookSendFileBufferFn);
  assertFunction("extractWorkspacePathsFromText", extractWorkspacePathsFromText);
  assertFunction("resolveWorkspacePathToHost", resolveWorkspacePathToHost);
  assertFunction("recordDeliveryMetric", recordDeliveryMetric);
  assertFunction("statImpl", statImpl);

  const inlineImageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"]);

  async function collectInlineWorkspaceImageMediaUrls({ text, routeAgentId }) {
    const normalizedText = String(text ?? "");
    const normalizedRouteAgentId = String(routeAgentId ?? "").trim();
    if (!normalizedText || !normalizedRouteAgentId) return [];
    const workspacePaths = extractWorkspacePathsFromText(normalizedText, 6);
    if (!Array.isArray(workspacePaths) || workspacePaths.length === 0) return [];

    const out = [];
    const seen = new Set();
    for (const workspacePath of workspacePaths) {
      const hostPath = resolveWorkspacePathToHost({
        workspacePath,
        agentId: normalizedRouteAgentId,
      });
      const normalizedHostPath = String(hostPath ?? "").trim();
      if (!normalizedHostPath || seen.has(normalizedHostPath)) continue;
      const lower = normalizedHostPath.toLowerCase();
      const ext = lower.includes(".") ? `.${lower.split(".").pop()}` : "";
      if (!inlineImageExts.has(ext)) continue;
      try {
        const fileStat = await statImpl(normalizedHostPath);
        if (!fileStat?.isFile?.()) continue;
        seen.add(normalizedHostPath);
        out.push(normalizedHostPath);
      } catch {
        // ignore non-existing paths
      }
    }
    return out;
  }

  const sendWebhookBotMediaBatch = createWecomWebhookBotMediaSender({
    resolveWebhookBotSendUrl: resolveWebhookBotSendUrlFn,
    resolveWecomOutboundMediaTarget,
    fetchMediaFromUrl,
    webhookSendImage: webhookSendImageFn,
    webhookSendFileBuffer: webhookSendFileBufferFn,
    attachWecomProxyDispatcher,
    fetchImpl,
  });
  const sendWecomBotPayloadViaResponseUrl = createWecomResponseUrlSender({
    attachWecomProxyDispatcher,
    parseWecomResponseUrlResult,
    fetchImpl,
  });
  const deliverActiveStreamReply = createWecomActiveStreamDeliverer({
    hasBotStream,
    resolveActiveBotStreamId,
    drainBotStreamMedia,
    normalizeWecomBotOutboundMediaUrls,
    buildActiveStreamMsgItems,
    finishBotStream,
    fetchMediaFromUrl,
  });
  const deliverWebhookBotReply = createWecomWebhookBotDeliverer({
    attachWecomProxyDispatcher,
    resolveWebhookBotSendUrl: resolveWebhookBotSendUrlFn,
    webhookSendText: webhookSendTextFn,
    webhookSendMarkdown,
    webhookSendTemplateCard,
    sendWebhookBotMediaBatch,
    fetchImpl,
  });
  const deliverResponseUrlReply = createWecomResponseUrlDeliverer({
    sendWecomBotPayloadViaResponseUrl,
    markBotResponseUrlUsed,
  });
  const deliverAgentPushReply = createWecomAgentPushDeliverer({
    getWecomConfig,
    sendWecomText,
  });

  async function deliverBotReplyText({
    api,
    fromUser,
    accountId = "default",
    sessionId,
    streamId,
    responseUrl,
    text,
    thinkingContent = "",
    routeAgentId = "",
    mediaUrl,
    mediaUrls,
    mediaType,
    reason = "reply",
  } = {}) {
    const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
    const fallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const observabilityPolicy = resolveWecomObservabilityPolicy(api);
    const botProxyUrl = resolveWecomBotProxyConfig(api, normalizedAccountId);
    const botModeConfig = resolveWecomBotConfig(api, normalizedAccountId);
    const normalizedText = String(text ?? "").trim();
    const inlineWorkspaceMediaUrls = await collectInlineWorkspaceImageMediaUrls({
      text: normalizedText,
      routeAgentId,
    });
    const normalizedMediaUrls = normalizeWecomBotOutboundMediaUrls({
      mediaUrl,
      mediaUrls: [...(Array.isArray(mediaUrls) ? mediaUrls : []), ...inlineWorkspaceMediaUrls],
    });
    const mixedPayload =
      normalizedMediaUrls.length > 0
        ? buildWecomBotMixedPayload({
            text: normalizedText,
            mediaUrls: normalizedMediaUrls,
          })
        : null;
    const fallbackText = normalizedText || "已收到模型返回的媒体结果，请查看以下链接。";
    const cardPayload = buildWecomBotCardPayload({
      text: normalizedText || fallbackText,
      cardPolicy: botModeConfig?.card,
      hasMedia: normalizedMediaUrls.length > 0,
    });
    const mediaFallbackSuffix =
      normalizedMediaUrls.length > 0 ? `\n\n媒体链接：\n${normalizedMediaUrls.join("\n")}` : "";

    const normalizedSessionId = String(sessionId ?? "").trim() || buildWecomBotSessionId(fromUser, normalizedAccountId);
    const inlineResponseUrl = String(responseUrl ?? "").trim();
    if (inlineResponseUrl) {
      upsertBotResponseUrlCache({
        sessionId: normalizedSessionId,
        responseUrl: inlineResponseUrl,
      });
    }
    const cachedResponseUrl = getBotResponseUrlCache(normalizedSessionId);
    const traceId = createDeliveryTraceId("wecom-bot");
    const router = createWecomDeliveryRouter({
      logger: api.logger,
      fallbackConfig: fallbackPolicy,
      observability: observabilityPolicy,
      handlers: {
        active_stream: async ({ text: content }) => {
          return deliverActiveStreamReply({
            streamId,
            sessionId: normalizedSessionId,
            content,
            thinkingContent,
            normalizedMediaUrls,
            mediaType,
            normalizedText,
            fallbackText,
            botProxyUrl,
            logger: api.logger,
          });
        },
        response_url: async ({ text: content }) => {
          return deliverResponseUrlReply({
            sessionId: normalizedSessionId,
            inlineResponseUrl,
            cachedResponseUrl,
            mixedPayload,
            cardPayload:
              botModeConfig?.card?.enabled === true && botModeConfig?.card?.responseUrlEnabled !== false
                ? cardPayload
                : null,
            content,
            fallbackText,
            logger: api.logger,
            proxyUrl: botProxyUrl,
            timeoutMs: webhookBotPolicy.timeoutMs,
          });
        },
        webhook_bot: async ({ text: content }) => {
          return deliverWebhookBotReply({
            api,
            webhookBotPolicy,
            botProxyUrl,
            content,
            fallbackText,
            normalizedText,
            normalizedMediaUrls,
            mediaType,
            cardPayload,
            cardPolicy: botModeConfig?.card ?? {},
          });
        },
        agent_push: async ({ text: content }) => {
          return deliverAgentPushReply({
            api,
            fromUser,
            accountId: normalizedAccountId,
            content,
            fallbackText,
            mediaFallbackSuffix,
          });
        },
      },
    });

    const deliveryResult = await router.deliverText({
      text: normalizedText || fallbackText,
      traceId,
      meta: {
        reason,
        fromUser,
        accountId: normalizedAccountId,
        sessionId: normalizedSessionId,
        streamId: streamId || "",
        hasResponseUrl: Boolean(inlineResponseUrl || cachedResponseUrl?.url),
        mediaCount: normalizedMediaUrls.length,
        hasThinkingContent: Boolean(String(thinkingContent ?? "").trim()),
        botCardMode: botModeConfig?.card?.enabled ? botModeConfig.card.mode : "off",
      },
    });
    recordDeliveryMetric({
      layer: deliveryResult?.layer || "",
      ok: deliveryResult?.ok === true,
      finalStatus: deliveryResult?.finalStatus || "",
      accountId: normalizedAccountId,
      attempts: deliveryResult?.attempts,
    });
    return deliveryResult;
  }

  return {
    deliverBotReplyText,
    sendWecomBotPayloadViaResponseUrl,
  };
}
