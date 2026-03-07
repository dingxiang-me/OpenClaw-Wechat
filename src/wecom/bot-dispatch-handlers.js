import { parseThinkingContent } from "./thinking-parser.js";

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
  state,
  hasBotStream,
  normalizeWecomBotOutboundMediaUrls,
  queueBotStreamMedia,
  updateBotStream,
  markdownToWecomText,
  isAgentFailureText,
  safeDeliverReply,
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

  const buildThinkingState = (rawText) => {
    const parsed = parseThinkingContent(rawText);
    const visibleRaw = String(parsed.visibleContent ?? "").trim();
    const thinkingRaw = String(parsed.thinkingContent ?? "").trim();
    return {
      rawText: String(rawText ?? ""),
      visibleText: visibleRaw ? markdownToWecomText(visibleRaw).trim() : "",
      thinkingContent: thinkingRaw ? markdownToWecomText(thinkingRaw).trim() : "",
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
        updateBotStream(streamId, blockState.visibleText, {
          append: false,
          finished: false,
          thinkingContent: blockState.thinkingContent,
        });
        return;
      }
      if (info.kind !== "final") return;
      if (payload?.text) {
        if (isAgentFailureText(payload.text)) {
          state.streamFinished = await safeDeliverReply(`抱歉，请求失败：${payload.text}`, "upstream-failure");
          return;
        }
        const finalState = buildThinkingState(payload.text);
        if (finalState.visibleText || finalState.thinkingContent) {
          state.streamFinished = await safeDeliverReply(
            {
              text: finalState.visibleText,
              thinkingContent: finalState.thinkingContent,
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
