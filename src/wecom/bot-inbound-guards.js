function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`bot-inbound-guards: ${name} is required`);
  }
}

function resolveGroupTriggerHint(groupChatPolicy = {}) {
  if (groupChatPolicy.triggerMode === "mention") {
    return "请先 @ 机器人后再发送消息。";
  }
  if (groupChatPolicy.triggerMode === "keyword") {
    return "当前消息未命中群聊触发关键词。";
  }
  return "当前消息不满足群聊触发条件。";
}

export function applyWecomBotGroupChatGuard({
  isGroupChat = false,
  msgType = "text",
  commandBody = "",
  groupChatPolicy = {},
  shouldTriggerWecomGroupResponse,
  shouldStripWecomGroupMentions,
  stripWecomGroupMentions,
} = {}) {
  assertFunction("shouldTriggerWecomGroupResponse", shouldTriggerWecomGroupResponse);
  assertFunction("shouldStripWecomGroupMentions", shouldStripWecomGroupMentions);
  assertFunction("stripWecomGroupMentions", stripWecomGroupMentions);

  if (!(isGroupChat && msgType === "text")) {
    return { ok: true, commandBody: String(commandBody ?? "") };
  }
  if (!groupChatPolicy?.enabled) {
    return { ok: false, finishText: "当前群聊消息处理未启用。", commandBody: String(commandBody ?? "") };
  }
  if (!shouldTriggerWecomGroupResponse(commandBody, groupChatPolicy)) {
    return {
      ok: false,
      finishText: resolveGroupTriggerHint(groupChatPolicy),
      commandBody: String(commandBody ?? ""),
    };
  }

  const nextCommandBody = shouldStripWecomGroupMentions(groupChatPolicy)
    ? stripWecomGroupMentions(commandBody, groupChatPolicy.mentionPatterns)
    : commandBody;
  return {
    ok: true,
    commandBody: String(nextCommandBody ?? ""),
  };
}

export function applyWecomBotCommandAndSenderGuard({
  api,
  accountId = "default",
  fromUser,
  msgType = "text",
  commandBody = "",
  normalizedFromUser = "",
  resolveWecomCommandPolicy,
  resolveWecomAllowFromPolicy,
  isWecomSenderAllowed,
  extractLeadingSlashCommand,
  buildWecomBotHelpText,
  buildWecomBotStatusText,
} = {}) {
  assertFunction("resolveWecomCommandPolicy", resolveWecomCommandPolicy);
  assertFunction("resolveWecomAllowFromPolicy", resolveWecomAllowFromPolicy);
  assertFunction("isWecomSenderAllowed", isWecomSenderAllowed);
  assertFunction("extractLeadingSlashCommand", extractLeadingSlashCommand);
  assertFunction("buildWecomBotHelpText", buildWecomBotHelpText);
  assertFunction("buildWecomBotStatusText", buildWecomBotStatusText);

  const commandPolicy = resolveWecomCommandPolicy(api);
  const isAdminUser = commandPolicy.adminUsers.includes(String(normalizedFromUser ?? "").trim().toLowerCase());
  const allowFromPolicy = resolveWecomAllowFromPolicy(api, accountId, {});
  const senderAllowed = isAdminUser || isWecomSenderAllowed({
    senderId: normalizedFromUser,
    allowFrom: allowFromPolicy.allowFrom,
  });
  if (!senderAllowed) {
    return {
      ok: false,
      finishText: allowFromPolicy.rejectMessage || "当前账号未授权，请联系管理员。",
      commandBody: String(commandBody ?? ""),
      isAdminUser,
      commandPolicy,
    };
  }

  let nextCommandBody = String(commandBody ?? "");
  if (msgType === "text") {
    let commandKey = extractLeadingSlashCommand(nextCommandBody);
    if (commandKey === "/clear") {
      nextCommandBody = nextCommandBody.replace(/^\/clear\b/i, "/reset");
      commandKey = "/reset";
    }
    if (commandKey) {
      const commandAllowed =
        commandPolicy.allowlist.includes(commandKey) ||
        (commandKey === "/reset" && commandPolicy.allowlist.includes("/clear"));
      if (commandPolicy.enabled && !isAdminUser && !commandAllowed) {
        return {
          ok: false,
          finishText: commandPolicy.rejectMessage,
          commandBody: nextCommandBody,
          isAdminUser,
          commandPolicy,
        };
      }
      if (commandKey === "/help") {
        return {
          ok: false,
          finishText: buildWecomBotHelpText(),
          commandBody: nextCommandBody,
          isAdminUser,
          commandPolicy,
        };
      }
      if (commandKey === "/status") {
        return {
          ok: false,
          finishText: buildWecomBotStatusText(api, fromUser),
          commandBody: nextCommandBody,
          isAdminUser,
          commandPolicy,
        };
      }
    }
  }

  return {
    ok: true,
    commandBody: nextCommandBody,
    isAdminUser,
    commandPolicy,
  };
}
