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
import {
  resolveWebhookBotSendUrl,
  webhookSendFileBuffer,
  webhookSendImage,
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
  statImpl = stat,
  fetchImpl = fetch,
} = {}) {
  assertFunction("attachWecomProxyDispatcher", attachWecomProxyDispatcher);
  assertFunction("resolveWecomDeliveryFallbackPolicy", resolveWecomDeliveryFallbackPolicy);
  assertFunction("resolveWecomWebhookBotDeliveryPolicy", resolveWecomWebhookBotDeliveryPolicy);
  assertFunction("resolveWecomObservabilityPolicy", resolveWecomObservabilityPolicy);
  assertFunction("resolveWecomBotProxyConfig", resolveWecomBotProxyConfig);
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
    const normalizedText = String(text ?? "").trim();
    const inlineWorkspaceMediaUrls = await collectInlineWorkspaceImageMediaUrls({
      text: normalizedText,
      routeAgentId,
    });
    const normalizedMediaUrls = normalizeWecomBotOutboundMediaUrls({
      mediaUrl,
      mediaUrls: [...(Array.isArray(mediaUrls) ? mediaUrls : []), ...inlineWorkspaceMediaUrls],
    });
    const mixedPayload = buildWecomBotMixedPayload({
      text: normalizedText,
      mediaUrls: normalizedMediaUrls,
    });
    const mediaFallbackSuffix =
      normalizedMediaUrls.length > 0 ? `\n\n媒体链接：\n${normalizedMediaUrls.join("\n")}` : "";
    const fallbackText = normalizedText || "已收到模型返回的媒体结果，请查看以下链接。";

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

    return router.deliverText({
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
      },
    });
  }

  return {
    deliverBotReplyText,
    sendWecomBotPayloadViaResponseUrl,
  };
}
