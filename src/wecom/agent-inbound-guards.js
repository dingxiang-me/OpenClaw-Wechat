import {
  issueWecomPairingChallenge,
  resolveWecomDirectMessageAccess,
} from "./pairing.js";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`agent-inbound-guards: ${name} is required`);
  }
}

export async function applyWecomAgentInboundGuards({
  api,
  config,
  accountId = "",
  fromUser,
  msgType = "text",
  isGroupChat = false,
  chatId = "",
  commandBody = "",
  normalizedFromUser = "",
  groupChatPolicy = {},
  shouldTriggerWecomGroupResponse,
  shouldStripWecomGroupMentions,
  stripWecomGroupMentions,
  resolveWecomCommandPolicy,
  resolveWecomAllowFromPolicy,
  resolveWecomDmPolicy,
  isWecomSenderAllowed,
  extractLeadingSlashCommand,
  COMMANDS,
  sendTextToUser,
  commandHandlerContext = {},
} = {}) {
  assertFunction("shouldTriggerWecomGroupResponse", shouldTriggerWecomGroupResponse);
  assertFunction("shouldStripWecomGroupMentions", shouldStripWecomGroupMentions);
  assertFunction("stripWecomGroupMentions", stripWecomGroupMentions);
  assertFunction("resolveWecomCommandPolicy", resolveWecomCommandPolicy);
  assertFunction("resolveWecomAllowFromPolicy", resolveWecomAllowFromPolicy);
  assertFunction("resolveWecomDmPolicy", resolveWecomDmPolicy);
  assertFunction("isWecomSenderAllowed", isWecomSenderAllowed);
  assertFunction("extractLeadingSlashCommand", extractLeadingSlashCommand);
  assertFunction("sendTextToUser", sendTextToUser);

  let nextCommandBody = String(commandBody ?? "");

  if (msgType === "text" && isGroupChat) {
    if (!groupChatPolicy.enabled) {
      api?.logger?.info?.(`wecom: group chat processing disabled, skipped chatId=${chatId || "unknown"}`);
      return { ok: false, commandBody: nextCommandBody, isAdminUser: false };
    }
    if (!shouldTriggerWecomGroupResponse(nextCommandBody, groupChatPolicy)) {
      api?.logger?.info?.(
        `wecom: group message skipped by trigger policy chatId=${chatId || "unknown"} mode=${groupChatPolicy.triggerMode || "direct"}`,
      );
      return { ok: false, commandBody: nextCommandBody, isAdminUser: false };
    }
    if (shouldStripWecomGroupMentions(groupChatPolicy)) {
      nextCommandBody = stripWecomGroupMentions(nextCommandBody, groupChatPolicy.mentionPatterns);
    }
    if (!nextCommandBody.trim()) {
      api?.logger?.info?.(`wecom: group message became empty after mention strip chatId=${chatId || "unknown"}`);
      return { ok: false, commandBody: nextCommandBody, isAdminUser: false };
    }
  }

  const commandPolicy = resolveWecomCommandPolicy(api);
  const isAdminUser = commandPolicy.adminUsers.includes(normalizedFromUser);
  const resolvedAccountId = config?.accountId || accountId || "default";
  const dmPolicy = resolveWecomDmPolicy(api, resolvedAccountId, config);
  const allowFromPolicy = resolveWecomAllowFromPolicy(api, resolvedAccountId, config);

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
      api?.logger?.warn?.(
        `wecom: sender blocked by group policy account=${resolvedAccountId} chatId=${chatId || "unknown"} user=${normalizedFromUser} mode=${groupPolicyMode || "open"}`,
      );
      if (groupChatPolicy?.rejectMessage) {
        await sendTextToUser(groupChatPolicy.rejectMessage);
      }
      return { ok: false, commandBody: nextCommandBody, isAdminUser };
    }
  }

  if (!isGroupChat) {
    const dmAccess = await resolveWecomDirectMessageAccess({
      api,
      accountId: resolvedAccountId,
      dmPolicy,
      allowFromPolicy,
      normalizedFromUser,
      isAdminUser,
      isWecomSenderAllowed,
    });
    if (dmAccess.decision === "pairing") {
      const pairing = await issueWecomPairingChallenge({
        api,
        accountId: resolvedAccountId,
        fromUser,
        normalizedFromUser,
        sendPairingReply: sendTextToUser,
      });
      if (!pairing.created && pairing.unsupported) {
        await sendTextToUser(dmPolicy.rejectMessage || "当前私聊需先完成配对审批。");
      }
      return { ok: false, commandBody: nextCommandBody, isAdminUser };
    }
    if (dmAccess.decision !== "allow") {
      await sendTextToUser(dmAccess.rejectText || dmPolicy.rejectMessage || "当前私聊账号未授权，请联系管理员。");
      return { ok: false, commandBody: nextCommandBody, isAdminUser };
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
    api?.logger?.warn?.(
      `wecom: sender blocked by allowFrom account=${config?.accountId || "default"} user=${normalizedFromUser}`,
    );
    if (allowFromPolicy.rejectMessage) {
      await sendTextToUser(allowFromPolicy.rejectMessage);
    }
    return { ok: false, commandBody: nextCommandBody, isAdminUser };
  }

  if (msgType === "text") {
    let commandKey = extractLeadingSlashCommand(nextCommandBody);
    if (commandKey === "/clear" || commandKey === "/new") {
      api?.logger?.info?.(`wecom: translating ${commandKey} to native /reset command`);
      nextCommandBody = nextCommandBody.replace(/^\/(?:clear|new)\b/i, "/reset");
      commandKey = "/reset";
    }
    if (commandKey) {
      const commandAllowed =
        commandPolicy.allowlist.includes(commandKey) ||
        (commandKey === "/reset" &&
          (commandPolicy.allowlist.includes("/clear") || commandPolicy.allowlist.includes("/new")));
      if (commandPolicy.enabled && !isAdminUser && !commandAllowed) {
        api?.logger?.info?.(`wecom: command blocked by allowlist user=${fromUser} command=${commandKey}`);
        await sendTextToUser(commandPolicy.rejectMessage);
        return { ok: false, commandBody: nextCommandBody, isAdminUser };
      }
      const handler = COMMANDS?.[commandKey];
      if (typeof handler === "function") {
        api?.logger?.info?.(`wecom: handling command ${commandKey}`);
        await handler(commandHandlerContext);
        return { ok: false, commandBody: nextCommandBody, isAdminUser, commandHandled: true };
      }
    }
  }

  return {
    ok: true,
    commandBody: nextCommandBody,
    isAdminUser,
    commandHandled: false,
  };
}
