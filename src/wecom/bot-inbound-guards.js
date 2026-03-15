import {
  issueWecomPairingChallenge,
  resolveWecomDirectMessageAccess,
} from "./pairing.js";

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

export async function applyWecomBotCommandAndSenderGuard({
  api,
  accountId = "default",
  fromUser,
  chatId = "",
  isGroupChat = false,
  msgType = "text",
  commandBody = "",
  normalizedFromUser = "",
  groupChatPolicy = {},
  resolveWecomCommandPolicy,
  resolveWecomAllowFromPolicy,
  resolveWecomDmPolicy,
  isWecomSenderAllowed,
  extractLeadingSlashCommand,
  buildWecomBotHelpText,
  buildWecomBotStatusText,
} = {}) {
  assertFunction("resolveWecomCommandPolicy", resolveWecomCommandPolicy);
  assertFunction("resolveWecomAllowFromPolicy", resolveWecomAllowFromPolicy);
  assertFunction("resolveWecomDmPolicy", resolveWecomDmPolicy);
  assertFunction("isWecomSenderAllowed", isWecomSenderAllowed);
  assertFunction("extractLeadingSlashCommand", extractLeadingSlashCommand);
  assertFunction("buildWecomBotHelpText", buildWecomBotHelpText);
  assertFunction("buildWecomBotStatusText", buildWecomBotStatusText);

  const commandPolicy = resolveWecomCommandPolicy(api);
  const isAdminUser = commandPolicy.adminUsers.includes(String(normalizedFromUser ?? "").trim().toLowerCase());
  const dmPolicy = resolveWecomDmPolicy(api, accountId, {});
  const allowFromPolicy = resolveWecomAllowFromPolicy(api, accountId, {});

  if (isGroupChat) {
    const groupPolicyMode = String(groupChatPolicy?.policyMode ?? (groupChatPolicy?.enabled === false ? "deny" : "open"))
      .trim()
      .toLowerCase();
    const groupSenderAllowed =
      isAdminUser ||
      groupPolicyMode === "open" ||
      (groupPolicyMode !== "deny" &&
        (groupChatPolicy.allowFrom.includes("*") ||
          isWecomSenderAllowed({
            senderId: normalizedFromUser,
            allowFrom: groupChatPolicy.allowFrom,
          })));
    if (!groupSenderAllowed) {
      return {
        ok: false,
        finishText: groupChatPolicy?.rejectMessage || "当前群聊发送者未授权，请联系管理员。",
        commandBody: String(commandBody ?? ""),
        isAdminUser,
        commandPolicy,
      };
    }
  }

  if (!isGroupChat) {
    const dmAccess = await resolveWecomDirectMessageAccess({
      api,
      accountId,
      dmPolicy,
      allowFromPolicy,
      normalizedFromUser,
      isAdminUser,
      isWecomSenderAllowed,
    });
    if (dmAccess.decision === "pairing") {
      const pairing = await issueWecomPairingChallenge({
        api,
        accountId,
        fromUser,
        normalizedFromUser,
        sendPairingReply: async (text) => text,
      });
      return {
        ok: false,
        finishText:
          pairing.created
            ? pairing.replyText || ""
            : !pairing.unsupported
              ? ""
            : dmPolicy.rejectMessage || "当前私聊需先完成配对审批。",
        commandBody: String(commandBody ?? ""),
        isAdminUser,
        commandPolicy,
      };
    }
    if (dmAccess.decision !== "allow") {
      return {
        ok: false,
        finishText: dmAccess.rejectText || dmPolicy.rejectMessage || "当前私聊账号未授权，请联系管理员。",
        commandBody: String(commandBody ?? ""),
        isAdminUser,
        commandPolicy,
      };
    }
  }

  const senderAllowed =
    isAdminUser ||
    allowFromPolicy.allowFrom.includes("*") ||
    isWecomSenderAllowed({
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
    if (commandKey === "/clear" || commandKey === "/new") {
      nextCommandBody = nextCommandBody.replace(/^\/(?:clear|new)\b/i, "/reset");
      commandKey = "/reset";
    }
    if (commandKey) {
      const commandAllowed =
        commandPolicy.allowlist.includes(commandKey) ||
        (commandKey === "/reset" &&
          (commandPolicy.allowlist.includes("/clear") || commandPolicy.allowlist.includes("/new")));
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
          finishText: buildWecomBotStatusText(api, fromUser, {
            accountId,
            chatId,
            isGroupChat,
          }),
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
