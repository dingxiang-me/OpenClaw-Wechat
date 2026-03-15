import { inferWecomDeliveryStatus } from "./reliable-delivery.js";
import { applyWecomReasoningPolicy } from "./reasoning-visibility.js";
import {
  extractWecomReplyDirectives,
  mergeWecomReplyMediaItems,
  resolveWecomReplyDirectiveMediaItems,
  selectWecomReplyTextVariant,
} from "./reply-output-policy.js";
import { parseThinkingContent } from "./thinking-parser.js";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentReplyDeliverer: ${name} is required`);
  }
}

export function createWecomAgentReplyDeliverer({
  getWecomConfig,
  sendWecomText,
  sendWecomMarkdown = null,
  sendWecomOutboundMediaBatch,
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
  resolveWorkspacePathToHost = () => "",
  createDeliveryTraceId,
  recordDeliveryMetric = () => {},
  recordReliableDeliveryOutcome = () => {},
  enqueuePendingReply = () => null,
} = {}) {
  assertFunction("getWecomConfig", getWecomConfig);
  assertFunction("sendWecomText", sendWecomText);
  assertFunction("sendWecomOutboundMediaBatch", sendWecomOutboundMediaBatch);
  assertFunction("resolveWecomReasoningPolicy", resolveWecomReasoningPolicy);
  assertFunction("resolveWecomReplyFormatPolicy", resolveWecomReplyFormatPolicy);
  assertFunction("resolveWorkspacePathToHost", resolveWorkspacePathToHost);
  assertFunction("createDeliveryTraceId", createDeliveryTraceId);
  assertFunction("recordDeliveryMetric", recordDeliveryMetric);
  assertFunction("recordReliableDeliveryOutcome", recordReliableDeliveryOutcome);
  assertFunction("enqueuePendingReply", enqueuePendingReply);

  return async function deliverAgentReply({
    api,
    fromUser,
    accountId = "default",
    sessionId = "",
    text = "",
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
    const normalizedText = String(text ?? "").trim();
    const normalizedRawText = String(rawText ?? normalizedText).trim();
    const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
    const normalizedSessionId = String(sessionId ?? "").trim();
    const traceId = createDeliveryTraceId("wecom-agent");
    const attempts = [];

    const parsedPlainReply =
      String(thinkingContent ?? "").trim().length > 0
        ? {
            visibleContent: normalizedText,
            thinkingContent: String(thinkingContent ?? "").trim(),
          }
        : parseThinkingContent(normalizedText);
    const parsedRawReply =
      String(rawThinkingContent ?? "").trim().length > 0
        ? {
            visibleContent: normalizedRawText,
            thinkingContent: String(rawThinkingContent ?? "").trim(),
          }
        : parseThinkingContent(normalizedRawText);

    const reasoningPolicy = resolveWecomReasoningPolicy(api);
    const plainReasoningPayload = applyWecomReasoningPolicy({
      text: parsedPlainReply.visibleContent,
      thinkingContent: parsedPlainReply.thinkingContent,
      policy: reasoningPolicy,
      transport: "agent",
      phase: "final",
    });
    const richReasoningPayload = applyWecomReasoningPolicy({
      text: parsedRawReply.visibleContent,
      thinkingContent: parsedRawReply.thinkingContent,
      policy: reasoningPolicy,
      transport: "agent",
      phase: "final",
    });

    const plainDirectivePayload = extractWecomReplyDirectives(plainReasoningPayload.text);
    const richDirectivePayload = extractWecomReplyDirectives(richReasoningPayload.text);
    const directiveMediaItems = resolveWecomReplyDirectiveMediaItems({
      mediaItems: richDirectivePayload.mediaItems,
      routeAgentId,
      resolveWorkspacePathToHost,
    });
    const normalizedMediaItems = mergeWecomReplyMediaItems({
      mediaUrl,
      mediaUrls,
      mediaItems,
      mediaType,
      extraMediaItems: directiveMediaItems,
    });
    const pendingMediaUrls = normalizedMediaItems.map((item) => item.url);
    const selectedReplyText = selectWecomReplyTextVariant({
      plainText: plainDirectivePayload.text,
      richText: richDirectivePayload.text,
      policy: resolveWecomReplyFormatPolicy(api),
      supportsMarkdown: typeof sendWecomMarkdown === "function",
    });
    const effectiveText = String(plainDirectivePayload.text ?? "").trim();

    const account = getWecomConfig(api, normalizedAccountId) ?? getWecomConfig(api, "default") ?? getWecomConfig(api);
    if (!account?.corpId || !account?.corpSecret || !account?.agentId) {
      const failed = {
        ok: false,
        layer: "agent_push",
        finalStatus: "failed",
        deliveryStatus: "rejected_target",
        attempts: [
          {
            layer: "agent_push",
            ok: false,
            status: "miss",
            deliveryStatus: "rejected_target",
            reason: "agent-config-missing",
          },
        ],
        error: "agent-config-missing",
      };
      recordDeliveryMetric({
        layer: failed.layer,
        ok: false,
        finalStatus: failed.finalStatus,
        deliveryStatus: failed.deliveryStatus,
        accountId: normalizedAccountId,
        attempts: failed.attempts,
      });
      recordReliableDeliveryOutcome({
        mode: "agent",
        accountId: normalizedAccountId,
        sessionId: normalizedSessionId,
        fromUser,
        deliveryStatus: failed.deliveryStatus,
        layer: failed.layer,
        reason: failed.error,
      });
      if (allowPendingEnqueue) {
        enqueuePendingReply(api, {
          mode: "agent",
          accountId: normalizedAccountId,
          sessionId: normalizedSessionId,
          fromUser,
          payload: {
            text: effectiveText,
            mediaUrls: pendingMediaUrls,
            mediaType,
          },
          reason,
          deliveryStatus: failed.deliveryStatus,
        });
      }
      return failed;
    }

    try {
      const sendTarget = {
        corpId: account.corpId,
        corpSecret: account.corpSecret,
        agentId: account.agentId,
        toUser: fromUser,
        logger: api?.logger,
        proxyUrl: account.outboundProxy,
        apiBaseUrl: account.apiBaseUrl,
      };
      if (selectedReplyText.text) {
        if (selectedReplyText.format === "markdown" && typeof sendWecomMarkdown === "function") {
          await sendWecomMarkdown({
            ...sendTarget,
            content: selectedReplyText.text,
          });
        } else {
          await sendWecomText({
            ...sendTarget,
            text: selectedReplyText.text,
          });
        }
      }

      let mediaResult = { sentCount: 0, failed: [] };
      if (normalizedMediaItems.length > 0) {
        mediaResult = await sendWecomOutboundMediaBatch({
          corpId: account.corpId,
          corpSecret: account.corpSecret,
          agentId: account.agentId,
          toUser: fromUser,
          mediaItems: normalizedMediaItems,
          logger: api?.logger,
          proxyUrl: account.outboundProxy,
          apiBaseUrl: account.apiBaseUrl,
        });
      }

      attempts.push({
        layer: "agent_push",
        ok: true,
        status: "ok",
        deliveryStatus: "delivered",
        reason: "",
      });
      const success = {
        ok: true,
        layer: "agent_push",
        finalStatus: "ok",
        deliveryStatus: "delivered",
        attempts,
        traceId,
        meta: {
          accountId: account.accountId || normalizedAccountId,
          mediaSent: Number(mediaResult.sentCount || 0),
          mediaFailed: Array.isArray(mediaResult.failed) ? mediaResult.failed.length : 0,
          replyFormat: selectedReplyText.format,
        },
      };
      recordDeliveryMetric({
        layer: success.layer,
        ok: true,
        finalStatus: success.finalStatus,
        deliveryStatus: success.deliveryStatus,
        accountId: normalizedAccountId,
        attempts: success.attempts,
      });
      recordReliableDeliveryOutcome({
        mode: "agent",
        accountId: normalizedAccountId,
        sessionId: normalizedSessionId,
        fromUser,
        deliveryStatus: success.deliveryStatus,
        layer: success.layer,
        reason,
      });
      return success;
    } catch (err) {
      const deliveryStatus = inferWecomDeliveryStatus({
        reason: String(err?.message || err),
        layer: "agent_push",
      });
      attempts.push({
        layer: "agent_push",
        ok: false,
        status: "error",
        deliveryStatus,
        reason: String(err?.message || err),
      });
      const failed = {
        ok: false,
        layer: "agent_push",
        finalStatus: "failed",
        deliveryStatus,
        attempts,
        error: String(err?.message || err),
        traceId,
      };
      recordDeliveryMetric({
        layer: failed.layer,
        ok: false,
        finalStatus: failed.finalStatus,
        deliveryStatus: failed.deliveryStatus,
        accountId: normalizedAccountId,
        attempts: failed.attempts,
      });
      recordReliableDeliveryOutcome({
        mode: "agent",
        accountId: normalizedAccountId,
        sessionId: normalizedSessionId,
        fromUser,
        deliveryStatus: failed.deliveryStatus,
        layer: failed.layer,
        reason: failed.error,
      });
      if (allowPendingEnqueue) {
        enqueuePendingReply(api, {
          mode: "agent",
          accountId: normalizedAccountId,
          sessionId: normalizedSessionId,
          fromUser,
          payload: {
            text: effectiveText,
            mediaUrls: pendingMediaUrls,
            mediaType,
          },
          reason: failed.error,
          deliveryStatus: failed.deliveryStatus,
        });
      }
      return failed;
    }
  };
}
