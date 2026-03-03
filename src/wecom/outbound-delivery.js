import { createWecomDeliveryRouter, parseWecomResponseUrlResult } from "../core/delivery-router.js";
import { buildWecomBotMixedPayload, normalizeWecomBotOutboundMediaUrls } from "./webhook-adapter.js";
import { resolveWecomOutboundMediaTarget } from "./media-url-utils.js";
import { createWecomActiveStreamDeliverer } from "./outbound-active-stream.js";
import { createWecomResponseUrlSender } from "./outbound-response-url.js";
import { createWecomWebhookBotMediaSender } from "./outbound-webhook-media.js";
import { buildActiveStreamMsgItems } from "./outbound-stream-msg-item.js";
import {
  resolveWebhookBotSendUrl,
  webhookSendFileBuffer,
  webhookSendImage,
  webhookSendText,
} from "./webhook-bot.js";

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

  function resolveWebhookDispatcher(url, proxyUrl, logger) {
    const options = attachWecomProxyDispatcher(url, {}, { proxyUrl, logger });
    return options?.dispatcher;
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

  async function deliverBotReplyText({
    api,
    fromUser,
    sessionId,
    streamId,
    responseUrl,
    text,
    mediaUrl,
    mediaUrls,
    mediaType,
    reason = "reply",
  } = {}) {
    const fallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const observabilityPolicy = resolveWecomObservabilityPolicy(api);
    const botProxyUrl = resolveWecomBotProxyConfig(api);
    const normalizedText = String(text ?? "").trim();
    const normalizedMediaUrls = normalizeWecomBotOutboundMediaUrls({ mediaUrl, mediaUrls });
    const mixedPayload = buildWecomBotMixedPayload({
      text: normalizedText,
      mediaUrls: normalizedMediaUrls,
    });
    const mediaFallbackSuffix =
      normalizedMediaUrls.length > 0 ? `\n\n媒体链接：\n${normalizedMediaUrls.join("\n")}` : "";
    const fallbackText = normalizedText || "已收到模型返回的媒体结果，请查看以下链接。";

    const normalizedSessionId = String(sessionId ?? "").trim() || buildWecomBotSessionId(fromUser);
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
          const targetUrl = inlineResponseUrl || cachedResponseUrl?.url || "";
          if (!targetUrl) {
            return { ok: false, reason: "response-url-missing" };
          }
          if (cachedResponseUrl?.used) {
            return { ok: false, reason: "response-url-used" };
          }
          const payload = mixedPayload || {
            msgtype: "text",
            text: {
              content: content || fallbackText,
            },
          };
          const result = await sendWecomBotPayloadViaResponseUrl({
            responseUrl: targetUrl,
            payload,
            logger: api.logger,
            proxyUrl: botProxyUrl,
            timeoutMs: webhookBotPolicy.timeoutMs,
          });
          markBotResponseUrlUsed(normalizedSessionId);
          return {
            ok: true,
            meta: {
              status: result.status,
              errcode: result.errcode ?? 0,
            },
          };
        },
        webhook_bot: async ({ text: content }) => {
          if (!webhookBotPolicy.enabled) {
            return { ok: false, reason: "webhook-bot-disabled" };
          }
          const sendUrl = resolveWebhookBotSendUrlFn({
            url: webhookBotPolicy.url,
            key: webhookBotPolicy.key,
          });
          if (!sendUrl) {
            return { ok: false, reason: "webhook-bot-url-missing" };
          }

          const dispatcher = resolveWebhookDispatcher(sendUrl, botProxyUrl, api.logger);
          const textPayload = `${content || fallbackText}`.trim();
          let sentAny = false;

          if (textPayload && (normalizedText || normalizedMediaUrls.length === 0)) {
            await webhookSendTextFn({
              url: webhookBotPolicy.url,
              key: webhookBotPolicy.key,
              content: textPayload,
              timeoutMs: webhookBotPolicy.timeoutMs,
              dispatcher,
              fetchImpl,
            });
            sentAny = true;
          }

          let mediaMeta = { sentCount: 0, failedCount: 0, failedUrls: [] };
          if (normalizedMediaUrls.length > 0) {
            mediaMeta = await sendWebhookBotMediaBatch({
              api,
              webhookBotPolicy,
              proxyUrl: botProxyUrl,
              mediaUrls: normalizedMediaUrls,
              mediaType,
            });
            sentAny = sentAny || mediaMeta.sentCount > 0;
          }

          if (!sentAny) {
            return { ok: false, reason: mediaMeta.reason || "webhook-bot-send-failed" };
          }

          if (mediaMeta.failedCount > 0) {
            await webhookSendTextFn({
              url: webhookBotPolicy.url,
              key: webhookBotPolicy.key,
              content: `以下媒体回传失败，已自动降级为链接：\n${mediaMeta.failedUrls.join("\n")}`,
              timeoutMs: webhookBotPolicy.timeoutMs,
              dispatcher,
              fetchImpl,
            });
          }

          return {
            ok: true,
            meta: {
              mediaSent: mediaMeta.sentCount,
              mediaFailed: mediaMeta.failedCount,
            },
          };
        },
        agent_push: async ({ text: content }) => {
          const account = getWecomConfig(api, "default") ?? getWecomConfig(api);
          if (!account?.corpId || !account?.corpSecret || !account?.agentId) {
            return { ok: false, reason: "agent-config-missing" };
          }
          await sendWecomText({
            corpId: account.corpId,
            corpSecret: account.corpSecret,
            agentId: account.agentId,
            toUser: fromUser,
            text: `${content || fallbackText}${mediaFallbackSuffix}`.trim(),
            logger: api.logger,
            proxyUrl: account.outboundProxy,
          });
          return {
            ok: true,
            meta: {
              accountId: account.accountId || "default",
            },
          };
        },
      },
    });

    return router.deliverText({
      text: normalizedText || fallbackText,
      traceId,
      meta: {
        reason,
        fromUser,
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
