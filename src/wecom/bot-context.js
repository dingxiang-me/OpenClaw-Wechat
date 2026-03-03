export function buildWecomBotInboundEnvelopePayload({
  fromUser,
  chatId,
  isGroupChat,
  messageText,
  timestamp = Date.now(),
} = {}) {
  return {
    channel: "WeCom Bot",
    from: isGroupChat && chatId ? `${fromUser} (group:${chatId})` : fromUser,
    timestamp,
    body: messageText,
    chatType: isGroupChat ? "group" : "direct",
    sender: {
      name: fromUser,
      id: fromUser,
    },
  };
}

export function buildWecomBotInboundContextPayload({
  body,
  messageText,
  originalContent,
  commandBody,
  fromAddress,
  sessionId,
  isGroupChat,
  chatId,
  fromUser,
  msgId,
  timestamp = Date.now(),
} = {}) {
  return {
    Body: body,
    BodyForAgent: messageText,
    RawBody: originalContent,
    CommandBody: commandBody,
    From: fromAddress,
    To: fromAddress,
    SessionKey: sessionId,
    AccountId: "bot",
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat && chatId ? `group:${chatId}` : fromUser,
    SenderName: fromUser,
    SenderId: fromUser,
    Provider: "wecom",
    Surface: "wecom-bot",
    MessageSid: msgId || `wecom-bot-${timestamp}`,
    Timestamp: timestamp,
    OriginatingChannel: "wecom",
    OriginatingTo: fromAddress,
  };
}
