function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentStreamingChunkManager: ${name} is required`);
  }
}

export function createWecomAgentStreamingChunkManager({
  state,
  streamingEnabled = false,
  streamingPolicy = {},
  markdownToWecomText,
  getByteLength,
  sendTextToUser,
  logger,
  now = () => Date.now(),
} = {}) {
  if (!state || typeof state !== "object") {
    throw new Error("createWecomAgentStreamingChunkManager: state is required");
  }
  assertFunction("markdownToWecomText", markdownToWecomText);
  assertFunction("getByteLength", getByteLength);
  assertFunction("sendTextToUser", sendTextToUser);
  assertFunction("now", now);

  const enqueueStreamingChunk = async (text, reason = "stream") => {
    const chunkText = String(text ?? "").trim();
    if (!chunkText || state.hasDeliveredReply) return;
    state.hasDeliveredPartialReply = true;
    state.streamChunkSendChain = state.streamChunkSendChain
      .then(async () => {
        await sendTextToUser(chunkText);
        state.streamChunkLastSentAt = now();
        state.streamChunkSentCount += 1;
        logger?.info?.(
          `wecom: streamed block chunk ${state.streamChunkSentCount} (${reason}), bytes=${getByteLength(chunkText)}`,
        );
      })
      .catch((streamErr) => {
        logger?.warn?.(`wecom: failed to send streaming block chunk: ${String(streamErr)}`);
      });
    await state.streamChunkSendChain;
  };

  const flushStreamingBuffer = async ({ force = false, reason = "stream" } = {}) => {
    if (!streamingEnabled || state.hasDeliveredReply) return false;
    const pendingText = String(state.streamChunkBuffer ?? "");
    const candidate = markdownToWecomText(pendingText).trim();
    if (!candidate) return false;

    const minChars = Math.max(20, Number(streamingPolicy.minChars || 120));
    const minIntervalMs = Math.max(200, Number(streamingPolicy.minIntervalMs || 1200));
    if (!force) {
      if (candidate.length < minChars) return false;
      if (now() - state.streamChunkLastSentAt < minIntervalMs) return false;
    }

    state.streamChunkBuffer = "";
    await enqueueStreamingChunk(candidate, reason);
    return true;
  };

  return {
    enqueueStreamingChunk,
    flushStreamingBuffer,
  };
}
