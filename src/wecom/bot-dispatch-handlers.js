import { parseThinkingContent } from "./thinking-parser.js";
import { applyWecomReasoningPolicy } from "./reasoning-visibility.js";
import { extractWecomReplyDirectives } from "./reply-output-policy.js";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomBotDispatchHandlers: ${name} is required`);
  }
}

export function normalizeWecomBotBlockText(currentText = "", incomingBlock = "") {
  const current = String(currentText ?? "");
  const incoming = String(incomingBlock ?? "");
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;
  return `${current}${incoming}`;
}

export function createWecomBotDispatchHandlers({
  api,
  streamId,
  sessionId,
  state,
  accountId = "default",
  hasBotStream,
  normalizeWecomBotOutboundMediaUrls,
  queueBotStreamMedia,
  updateBotStream,
  pushWecomBotLongConnectionStreamUpdate,
  markdownToWecomText,
  isAgentFailureText,
  safeDeliverReply,
  reasoningPolicy = {},
} = {}) {
  if (!state || typeof state !== "object") {
    throw new Error("createWecomBotDispatchHandlers: state is required");
  }
  if (!("blockText" in state)) state.blockText = "";
  if (!("streamFinished" in state)) state.streamFinished = false;
  assertFunction("hasBotStream", hasBotStream);
  assertFunction("normalizeWecomBotOutboundMediaUrls", normalizeWecomBotOutboundMediaUrls);
  assertFunction("queueBotStreamMedia", queueBotStreamMedia);
  assertFunction("updateBotStream", updateBotStream);
  assertFunction("markdownToWecomText", markdownToWecomText);
  assertFunction("isAgentFailureText", isAgentFailureText);
  assertFunction("safeDeliverReply", safeDeliverReply);

  const logger = api?.logger;

  const buildThinkingState = (rawText, rawThinkingOverride = "") => {
    const parsed = parseThinkingContent(rawText);
    const visibleRaw = String(parsed.visibleContent ?? "").trim();
    const thinkingRaw = String(parsed.thinkingContent ?? "").trim();
    const visibleText = visibleRaw ? markdownToWecomText(visibleRaw).trim() : "";
    const thinkingContent = (thinkingRaw ? markdownToWecomText(thinkingRaw).trim() : "") || String(rawThinkingOverride ?? "").trim();
    const rawThinkingContent = String(rawThinkingOverride ?? "").trim() || thinkingRaw;
    const cleanedStreamPayload = applyWecomReasoningPolicy({
      text: visibleText,
      thinkingContent,
      policy: reasoningPolicy,
      transport: "bot",
      phase: "stream",
    });
    const cleanedFinalPayload = applyWecomReasoningPolicy({
      text: visibleText,
      thinkingContent,
      policy: reasoningPolicy,
      transport: "bot",
      phase: "final",
    });
    const rawFinalPayload = applyWecomReasoningPolicy({
      text: visibleRaw,
      thinkingContent: rawThinkingContent,
      policy: reasoningPolicy,
      transport: "bot",
      phase: "final",
    });
    return {
      rawText: String(rawText ?? ""),
      streamPayload: {
        ...cleanedStreamPayload,
        text: extractWecomReplyDirectives(cleanedStreamPayload.text).text,
      },
      finalPayload: {
        ...cleanedFinalPayload,
        text: extractWecomReplyDirectives(cleanedFinalPayload.text).text,
        rawText: String(rawFinalPayload.text ?? "").trim(),
        rawThinkingContent: String(rawFinalPayload.thinkingContent ?? "").trim(),
      },
    };
  };

  return {
    deliver: async (payload, info) => {
      if (!hasBotStream(streamId)) return;
      if (info.kind === "block") {
        const blockMediaUrls = normalizeWecomBotOutboundMediaUrls(payload);
        if (blockMediaUrls.length > 0) {
          const blockMediaType = String(payload?.mediaType ?? "").trim().toLowerCase() || undefined;
          for (const mediaUrl of blockMediaUrls) {
            queueBotStreamMedia(streamId, mediaUrl, { mediaType: blockMediaType });
          }
          logger?.debug?.(
            `wecom(bot): queued block media stream=${streamId} count=${blockMediaUrls.length} type=${blockMediaType || "unknown"}`,
          );
        }
        if (!payload?.text) return;
        state.blockText = normalizeWecomBotBlockText(state.blockText, payload.text);
        const blockState = buildThinkingState(state.blockText);
        updateBotStream(streamId, blockState.streamPayload.text, {
          append: false,
          finished: false,
          thinkingContent: blockState.streamPayload.thinkingContent,
        });
        if (typeof pushWecomBotLongConnectionStreamUpdate === "function") {
          try {
            await pushWecomBotLongConnectionStreamUpdate({
              accountId,
              sessionId,
              streamId,
              content: blockState.streamPayload.text,
              finish: false,
              thinkingContent: blockState.streamPayload.thinkingContent,
            });
          } catch (err) {
            logger?.warn?.(
              `wecom(bot-longconn): failed to push block stream update: ${String(err?.message || err)}`,
            );
          }
        }
        return;
      }
      if (info.kind !== "final") return;
      if (payload?.text) {
        if (isAgentFailureText(payload.text)) {
          state.streamFinished = await safeDeliverReply(`抱歉，请求失败：${payload.text}`, "upstream-failure");
          return;
        }
        const finalState = buildThinkingState(payload.text);
        if (finalState.finalPayload.text || finalState.finalPayload.thinkingContent) {
          state.streamFinished = await safeDeliverReply(
            {
              text: finalState.finalPayload.text,
              thinkingContent: finalState.finalPayload.thinkingContent,
              rawText: finalState.finalPayload.rawText,
              rawThinkingContent: finalState.finalPayload.rawThinkingContent,
            },
            "final",
          );
          return;
        }
      }
      if (payload?.mediaUrl || (payload?.mediaUrls?.length ?? 0) > 0) {
        state.streamFinished = await safeDeliverReply(
          {
            text: "已收到模型返回的媒体结果。",
            mediaUrl: payload.mediaUrl,
            mediaUrls: payload.mediaUrls,
          },
          "final-media",
        );
      }
    },
    onError: async (err, info) => {
      logger?.error?.(`wecom(bot): ${info.kind} reply failed: ${String(err)}`);
      state.streamFinished = await safeDeliverReply(
        `抱歉，当前模型请求失败，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
        `dispatch-${info.kind}-error`,
      );
    },
  };
}
