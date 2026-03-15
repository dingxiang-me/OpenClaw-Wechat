export function createWecomTextInboundScheduler({
  resolveWecomGroupChatPolicy,
  shouldStripWecomGroupMentions,
  stripWecomGroupMentions,
  extractLeadingSlashCommand,
  resolveWecomTextDebouncePolicy,
  buildWecomSessionId,
  messageProcessLimiter,
  executeInboundTaskWithSessionQueue,
  getProcessInboundMessage,
} = {}) {
  if (typeof resolveWecomGroupChatPolicy !== "function") {
    throw new Error("createWecomTextInboundScheduler: resolveWecomGroupChatPolicy is required");
  }
  if (typeof shouldStripWecomGroupMentions !== "function") {
    throw new Error("createWecomTextInboundScheduler: shouldStripWecomGroupMentions is required");
  }
  if (typeof stripWecomGroupMentions !== "function") {
    throw new Error("createWecomTextInboundScheduler: stripWecomGroupMentions is required");
  }
  if (typeof extractLeadingSlashCommand !== "function") {
    throw new Error("createWecomTextInboundScheduler: extractLeadingSlashCommand is required");
  }
  if (typeof resolveWecomTextDebouncePolicy !== "function") {
    throw new Error("createWecomTextInboundScheduler: resolveWecomTextDebouncePolicy is required");
  }
  if (typeof buildWecomSessionId !== "function") {
    throw new Error("createWecomTextInboundScheduler: buildWecomSessionId is required");
  }
  if (!messageProcessLimiter || typeof messageProcessLimiter.execute !== "function") {
    throw new Error("createWecomTextInboundScheduler: messageProcessLimiter.execute is required");
  }
  if (typeof executeInboundTaskWithSessionQueue !== "function") {
    throw new Error("createWecomTextInboundScheduler: executeInboundTaskWithSessionQueue is required");
  }
  if (typeof getProcessInboundMessage !== "function") {
    throw new Error("createWecomTextInboundScheduler: getProcessInboundMessage is required");
  }

  const textMessageDebounceBuffers = new Map();

  function buildTextDebounceBufferKey({ accountId, fromUser, chatId, isGroupChat }) {
    const account = String(accountId ?? "default").trim().toLowerCase() || "default";
    const user = String(fromUser ?? "").trim().toLowerCase();
    const group = String(chatId ?? "").trim().toLowerCase();
    if (isGroupChat) {
      return `${account}:group:${group || "unknown"}:user:${user || "unknown"}`;
    }
    return `${account}:dm:${user || "unknown"}`;
  }

  function dispatchTextPayload(api, payload, reason = "direct") {
    const sessionId = buildWecomSessionId(payload?.fromUser, payload?.accountId);
    messageProcessLimiter
      .execute(() =>
        executeInboundTaskWithSessionQueue({
          api,
          sessionId,
          isBot: false,
          task: () => {
            const processInboundMessage = getProcessInboundMessage();
            if (typeof processInboundMessage !== "function") {
              throw new Error("wecom: processInboundMessage is not ready");
            }
            return processInboundMessage(payload);
          },
        }),
      )
      .catch((err) => {
        api.logger.error?.(`wecom: async text processing failed (${reason}): ${err.message}`);
      });
  }

  function flushTextDebounceBuffer(api, debounceKey, reason = "timer") {
    const buffered = textMessageDebounceBuffers.get(debounceKey);
    if (!buffered) return;

    textMessageDebounceBuffers.delete(debounceKey);
    if (buffered.timer) clearTimeout(buffered.timer);
    const mergedContent = buffered.messages.join("\n").trim();
    if (!mergedContent) return;

    api.logger.info?.(
      `wecom: flushing debounced text buffer key=${debounceKey} count=${buffered.messages.length} reason=${reason}`,
    );
    dispatchTextPayload(
      api,
      {
        ...buffered.basePayload,
        msgType: "text",
        content: mergedContent,
        msgId: buffered.msgIds[0] ?? buffered.basePayload.msgId ?? "",
      },
      `debounce:${reason}`,
    );
  }

  function scheduleTextInboundProcessing(api, basePayload, content) {
    const text = String(content ?? "");
    let commandProbeText = text;
    if (basePayload?.isGroupChat) {
      const groupPolicy = resolveWecomGroupChatPolicy(
        api,
        basePayload?.accountId || "default",
        {},
        basePayload?.chatId || "",
      );
      if (shouldStripWecomGroupMentions(groupPolicy)) {
        commandProbeText = stripWecomGroupMentions(commandProbeText, groupPolicy.mentionPatterns);
      }
    }
    const command = extractLeadingSlashCommand(commandProbeText);
    const debounceConfig = resolveWecomTextDebouncePolicy(api);
    const debounceKey = buildTextDebounceBufferKey(basePayload);

    if (command) {
      flushTextDebounceBuffer(api, debounceKey, "command-priority");
      dispatchTextPayload(api, { ...basePayload, content: text, msgType: "text" }, "command");
      return;
    }

    if (!debounceConfig.enabled) {
      dispatchTextPayload(api, { ...basePayload, content: text, msgType: "text" }, "direct");
      return;
    }

    const existing = textMessageDebounceBuffers.get(debounceKey);
    if (!existing) {
      const timer = setTimeout(() => {
        flushTextDebounceBuffer(api, debounceKey, "window-expired");
      }, debounceConfig.windowMs);
      timer.unref?.();

      textMessageDebounceBuffers.set(debounceKey, {
        basePayload,
        messages: [text],
        msgIds: [basePayload.msgId ?? ""],
        timer,
        updatedAt: Date.now(),
      });
      api.logger.info?.(`wecom: buffered text message key=${debounceKey} count=1 windowMs=${debounceConfig.windowMs}`);
      return;
    }

    if (existing.timer) clearTimeout(existing.timer);
    existing.messages.push(text);
    existing.msgIds.push(basePayload.msgId ?? "");
    existing.updatedAt = Date.now();

    if (existing.messages.length >= debounceConfig.maxBatch) {
      flushTextDebounceBuffer(api, debounceKey, "max-batch");
      return;
    }

    existing.timer = setTimeout(() => {
      flushTextDebounceBuffer(api, debounceKey, "window-expired");
    }, debounceConfig.windowMs);
    existing.timer.unref?.();
    textMessageDebounceBuffers.set(debounceKey, existing);
  }

  return {
    scheduleTextInboundProcessing,
    flushTextDebounceBuffer,
    buildTextDebounceBufferKey,
    dispatchTextPayload,
  };
}
