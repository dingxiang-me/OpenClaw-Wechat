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
import { inferWecomDeliveryStatus } from "./reliable-delivery.js";
import { applyWecomReasoningPolicy } from "./reasoning-visibility.js";
import {
  extractWecomReplyDirectives,
  mergeWecomReplyMediaItems,
  resolveWecomReplyDirectiveMediaItems,
} from "./reply-output-policy.js";
import { parseThinkingContent } from "./thinking-parser.js";

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
  resolveWecomReasoningPolicy = () => ({
    mode: "separate",
    sendThinkingMessage: true,
    includeInFinalAnswer: false,
    title: "思考过程",
    maxChars: 1200,
  }),
  resolveWecomReplyFormatPolicy = () => ({
    mode: "auto",
  }),
  resolveWecomBotProxyConfig,
  resolveWecomBotConfig,
  resolveWecomBotLongConnectionReplyContext,
  pushWecomBotLongConnectionStreamUpdate,
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
  recordReliableDeliveryOutcome = () => {},
  enqueuePendingReply = () => null,
  statImpl = stat,
  fetchImpl = fetch,
} = {}) {
  assertFunction("attachWecomProxyDispatcher", attachWecomProxyDispatcher);
  assertFunction("resolveWecomDeliveryFallbackPolicy", resolveWecomDeliveryFallbackPolicy);
  assertFunction("resolveWecomWebhookBotDeliveryPolicy", resolveWecomWebhookBotDeliveryPolicy);
  assertFunction("resolveWecomObservabilityPolicy", resolveWecomObservabilityPolicy);
  assertFunction("resolveWecomReasoningPolicy", resolveWecomReasoningPolicy);
  assertFunction("resolveWecomReplyFormatPolicy", resolveWecomReplyFormatPolicy);
  assertFunction("resolveWecomBotProxyConfig", resolveWecomBotProxyConfig);
  assertFunction("resolveWecomBotConfig", resolveWecomBotConfig);
  assertFunction("resolveWecomBotLongConnectionReplyContext", resolveWecomBotLongConnectionReplyContext);
  assertFunction("pushWecomBotLongConnectionStreamUpdate", pushWecomBotLongConnectionStreamUpdate);
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
  assertFunction("recordReliableDeliveryOutcome", recordReliableDeliveryOutcome);
  assertFunction("enqueuePendingReply", enqueuePendingReply);
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
    rawText = "",
    thinkingContent = "",
    rawThinkingContent = "",
    routeAgentId = "",
    mediaUrl,
    mediaUrls,
    mediaItems,
    mediaType,
    reason = "reply",
    allowPendingEnqueue = true,
  } = {}) {
    const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
    const fallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const observabilityPolicy = resolveWecomObservabilityPolicy(api);
    const reasoningPolicy = resolveWecomReasoningPolicy(api);
    const replyFormatPolicy = resolveWecomReplyFormatPolicy(api);
    const botProxyUrl = resolveWecomBotProxyConfig(api, normalizedAccountId);
    const botModeConfig = resolveWecomBotConfig(api, normalizedAccountId);
    const normalizedText = String(text ?? "").trim();
    const normalizedRawText = String(rawText ?? normalizedText).trim();
    const parsedText =
      String(thinkingContent ?? "").trim().length > 0
        ? {
            visibleContent: normalizedText,
            thinkingContent: String(thinkingContent ?? "").trim(),
          }
        : parseThinkingContent(normalizedText);
    const parsedRawText =
      String(rawThinkingContent ?? "").trim().length > 0
        ? {
            visibleContent: normalizedRawText,
            thinkingContent: String(rawThinkingContent ?? "").trim(),
          }
        : parseThinkingContent(normalizedRawText);
    const reasoningPayload = applyWecomReasoningPolicy({
      text: parsedText.visibleContent,
      thinkingContent: parsedText.thinkingContent,
      policy: reasoningPolicy,
      transport: "bot",
      phase: "final",
    });
    const richReasoningPayload = applyWecomReasoningPolicy({
      text: parsedRawText.visibleContent,
      thinkingContent: parsedRawText.thinkingContent,
      policy: reasoningPolicy,
      transport: "bot",
      phase: "final",
    });
    const plainDirectivePayload = extractWecomReplyDirectives(reasoningPayload.text);
    const richDirectivePayload = extractWecomReplyDirectives(richReasoningPayload.text);
    const effectiveText = String(plainDirectivePayload.text ?? "").trim();
    const richEffectiveText = String(richDirectivePayload.text ?? "").trim();
    const effectiveThinkingContent = String(reasoningPayload.thinkingContent ?? "").trim();
    const directiveMediaItems = resolveWecomReplyDirectiveMediaItems({
      mediaItems: richDirectivePayload.mediaItems,
      routeAgentId,
      resolveWorkspacePathToHost,
    });
    const inlineWorkspaceMediaUrls = await collectInlineWorkspaceImageMediaUrls({
      text: richEffectiveText || effectiveText,
      routeAgentId,
    });
    const normalizedMediaItems = mergeWecomReplyMediaItems({
      mediaUrl,
      mediaUrls: [...(Array.isArray(mediaUrls) ? mediaUrls : []), ...inlineWorkspaceMediaUrls],
      mediaItems,
      mediaType,
      extraMediaItems: directiveMediaItems,
    });
    const normalizedMediaUrls = normalizeWecomBotOutboundMediaUrls({
      mediaUrls: normalizedMediaItems.map((item) => item.url),
    });
    const mixedPayload =
      normalizedMediaUrls.length > 0
        ? buildWecomBotMixedPayload({
            text: effectiveText,
            mediaUrls: normalizedMediaUrls,
          })
        : null;
    const fallbackText = effectiveText || "已收到模型返回的媒体结果，请查看以下链接。";
    const cardPayload = buildWecomBotCardPayload({
      text:
        String(replyFormatPolicy?.mode ?? "").trim().toLowerCase() === "markdown" && richEffectiveText
          ? richEffectiveText
          : effectiveText || fallbackText,
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
    const longConnectionContext = resolveWecomBotLongConnectionReplyContext({
      accountId: normalizedAccountId,
      sessionId: normalizedSessionId,
      streamId,
    });
    const traceId = createDeliveryTraceId("wecom-bot");
    const router = createWecomDeliveryRouter({
      logger: api.logger,
      fallbackConfig: fallbackPolicy,
      observability: observabilityPolicy,
      handlers: {
        long_connection: async ({ text: content }) => {
          let streamMsgItem = [];
          let fallbackMediaUrls = normalizedMediaUrls;
          if (normalizedMediaUrls.length > 0) {
            const processed = await buildActiveStreamMsgItems({
              mediaUrls: normalizedMediaUrls,
              mediaItems: normalizedMediaItems,
              mediaType,
              fetchMediaFromUrl,
              proxyUrl: botProxyUrl,
              logger: api.logger,
            });
            streamMsgItem = processed.msgItem;
            fallbackMediaUrls = processed.fallbackUrls;
          }
          let streamContent = String(content ?? "").trim();
          if (!streamContent && fallbackMediaUrls.length > 0) {
            streamContent = fallbackText;
          }
          if (fallbackMediaUrls.length > 0) {
            streamContent = `${streamContent}\n\n媒体链接：\n${fallbackMediaUrls.join("\n")}`.trim();
          }
          if (!streamContent && !streamMsgItem.length && !effectiveThinkingContent) {
            streamContent = fallbackText;
          }
          return pushWecomBotLongConnectionStreamUpdate({
            accountId: normalizedAccountId,
            sessionId: normalizedSessionId,
            streamId,
            content: streamContent,
            finish: true,
            msgItem: streamMsgItem,
            thinkingContent: effectiveThinkingContent,
          });
        },
        active_stream: async ({ text: content }) => {
          return deliverActiveStreamReply({
            streamId,
            sessionId: normalizedSessionId,
            content,
            thinkingContent: effectiveThinkingContent,
            normalizedMediaUrls,
            mediaType,
            normalizedText: effectiveText,
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
            richContent:
              String(replyFormatPolicy?.mode ?? "").trim().toLowerCase() === "markdown" ? richEffectiveText : "",
            replyFormatMode: replyFormatPolicy?.mode || "auto",
            fallbackText,
            normalizedText: effectiveText,
            normalizedMediaUrls,
            normalizedMediaItems,
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
      text: effectiveText || fallbackText,
      traceId,
      meta: {
        reason,
        fromUser,
        accountId: normalizedAccountId,
        sessionId: normalizedSessionId,
        streamId: streamId || "",
        hasResponseUrl: Boolean(inlineResponseUrl || cachedResponseUrl?.url),
        mediaCount: normalizedMediaUrls.length,
        hasThinkingContent: Boolean(effectiveThinkingContent),
        botCardMode: botModeConfig?.card?.enabled ? botModeConfig.card.mode : "off",
      },
    });
    recordDeliveryMetric({
      layer: deliveryResult?.layer || "",
      ok: deliveryResult?.ok === true,
      finalStatus: deliveryResult?.finalStatus || "",
      deliveryStatus: deliveryResult?.deliveryStatus || "",
      accountId: normalizedAccountId,
      attempts: deliveryResult?.attempts,
    });
    recordReliableDeliveryOutcome({
      mode: "bot",
      accountId: normalizedAccountId,
      sessionId: normalizedSessionId,
      fromUser,
      deliveryStatus:
        deliveryResult?.deliveryStatus ||
        (deliveryResult?.ok === true
          ? "delivered"
          : inferWecomDeliveryStatus({
              reason: deliveryResult?.error || deliveryResult?.attempts?.slice?.(-1)?.[0]?.reason || "delivery-failed",
              layer: deliveryResult?.layer || deliveryResult?.attempts?.slice?.(-1)?.[0]?.layer || "",
            })),
      layer: deliveryResult?.layer || deliveryResult?.attempts?.slice?.(-1)?.[0]?.layer || "",
      reason: deliveryResult?.error || deliveryResult?.attempts?.slice?.(-1)?.[0]?.reason || reason,
    });
    if (deliveryResult?.ok !== true && allowPendingEnqueue) {
      enqueuePendingReply(api, {
        mode: "bot",
        accountId: normalizedAccountId,
          sessionId: normalizedSessionId,
          fromUser,
          payload: {
            text: effectiveText || fallbackText,
            thinkingContent: effectiveThinkingContent,
            mediaUrls: normalizedMediaUrls,
            mediaItems: normalizedMediaItems,
            mediaType,
          },
        reason: deliveryResult?.error || deliveryResult?.attempts?.slice?.(-1)?.[0]?.reason || reason,
        deliveryStatus: deliveryResult?.deliveryStatus || "rejected_unknown",
      });
    }
    return deliveryResult;
  }

  return {
    deliverBotReplyText,
    sendWecomBotPayloadViaResponseUrl,
  };
}
