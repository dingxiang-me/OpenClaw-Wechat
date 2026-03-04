import {
  collectWecomBotImageUrls,
  dedupeUrlList,
  normalizeLowerToken,
  normalizeQuotePayload,
  normalizeToken,
  normalizeWecomBotOutboundMediaUrls,
} from "./webhook-adapter-normalize.js";

export { collectWecomBotImageUrls, normalizeWecomBotOutboundMediaUrls };

export function buildWecomBotMixedPayload({ text = "", mediaUrl, mediaUrls } = {}) {
  const normalizedText = normalizeToken(text);
  const normalizedMediaUrls = normalizeWecomBotOutboundMediaUrls({ mediaUrl, mediaUrls }).slice(0, 6);

  if (normalizedMediaUrls.length === 0) {
    if (!normalizedText) return null;
    return {
      msgtype: "text",
      text: { content: normalizedText },
    };
  }

  const msgItems = [];
  if (normalizedText) {
    msgItems.push({
      msgtype: "text",
      text: { content: normalizedText },
    });
  }
  for (const imageUrl of normalizedMediaUrls) {
    msgItems.push({
      msgtype: "image",
      image: { url: imageUrl },
    });
  }

  if (msgItems.length === 0) return null;
  return {
    msgtype: "mixed",
    mixed: {
      msg_item: msgItems,
    },
  };
}

export function parseWecomBotInboundMessage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const msgType = normalizeLowerToken(payload.msgtype);
  if (!msgType) return null;
  const feedbackId = normalizeToken(payload?.feedback?.id || payload?.stream?.feedback?.id);
  if (msgType === "stream") {
    return {
      kind: "stream-refresh",
      streamId: normalizeToken(payload?.stream?.id),
      feedbackId,
    };
  }

  const msgId = normalizeToken(payload.msgid) || `wecom-bot-${Date.now()}`;
  const fromUser = normalizeToken(payload?.from?.userid);
  const chatType = normalizeLowerToken(payload.chattype || "single") || "single";
  const chatId = normalizeToken(payload.chatid);
  const responseUrl = normalizeToken(payload.response_url);
  const quote = normalizeQuotePayload(payload.quote);
  let content = "";
  const imageUrls = [];
  let fileUrl = "";
  let fileName = "";
  let voiceUrl = "";
  let voiceMediaId = "";
  let voiceContentType = "";

  if (msgType === "text") {
    content = normalizeToken(payload?.text?.content);
  } else if (msgType === "voice") {
    content = normalizeToken(payload?.voice?.content);
    voiceUrl = normalizeToken(
      payload?.voice?.url ||
        payload?.voice?.media_url ||
        payload?.voice?.download_url ||
        payload?.voice?.file_url,
    );
    voiceMediaId = normalizeToken(payload?.voice?.media_id || payload?.voice?.mediaid || payload?.voice?.id);
    voiceContentType = normalizeToken(payload?.voice?.content_type || payload?.voice?.mime_type || payload?.voice?.format);
  } else if (msgType === "link") {
    const title = normalizeToken(payload?.link?.title);
    const description = normalizeToken(payload?.link?.description);
    const url = normalizeToken(payload?.link?.url);
    content = [title ? `[链接] ${title}` : "", description, url].filter(Boolean).join("\n").trim();
  } else if (msgType === "location") {
    const latitude = normalizeToken(payload?.location?.latitude);
    const longitude = normalizeToken(payload?.location?.longitude);
    const name = normalizeToken(payload?.location?.name || payload?.location?.label);
    content = name ? `[位置] ${name} (${latitude}, ${longitude})` : `[位置] ${latitude}, ${longitude}`;
  } else if (msgType === "image") {
    imageUrls.push(...collectWecomBotImageUrls(payload?.image));
    content = "[图片]";
  } else if (msgType === "mixed") {
    const items = Array.isArray(payload?.mixed?.msg_item) ? payload.mixed.msg_item : [];
    const parts = [];
    for (const item of items) {
      const itemType = normalizeLowerToken(item?.msgtype);
      if (itemType === "text") {
        const text = normalizeToken(item?.text?.content);
        if (text) parts.push(text);
      } else if (itemType === "image") {
        const itemImageUrls = collectWecomBotImageUrls(item?.image);
        if (itemImageUrls.length > 0) {
          imageUrls.push(...itemImageUrls);
          parts.push("[图片]");
        }
      } else if (itemType === "voice") {
        const itemVoiceUrl = normalizeToken(
          item?.voice?.url ||
            item?.voice?.media_url ||
            item?.voice?.download_url ||
            item?.voice?.file_url,
        );
        const itemVoiceMediaId = normalizeToken(item?.voice?.media_id || item?.voice?.mediaid || item?.voice?.id);
        const itemVoiceContentType = normalizeToken(
          item?.voice?.content_type || item?.voice?.mime_type || item?.voice?.format,
        );
        if (itemVoiceUrl) {
          voiceUrl = voiceUrl || itemVoiceUrl;
          voiceMediaId = voiceMediaId || itemVoiceMediaId;
          voiceContentType = voiceContentType || itemVoiceContentType;
          parts.push("[语音]");
        }
      }
    }
    content = parts.join("\n").trim();
  } else if (msgType === "file") {
    fileUrl = normalizeToken(payload?.file?.url);
    fileName = normalizeToken(payload?.file?.name || payload?.file?.filename);
    const displayName = fileName || fileUrl || "附件";
    content = `[文件] ${displayName}`;
  } else if (msgType === "event") {
    return {
      kind: "event",
      eventType: normalizeToken(payload?.event?.event_type || payload?.event),
      fromUser,
    };
  } else {
    return {
      kind: "unsupported",
      msgType,
      fromUser,
      msgId,
    };
  }

  if (!fromUser) {
    return {
      kind: "invalid",
      reason: "missing-from-user",
      msgType,
      msgId,
    };
  }

  return {
    kind: "message",
    msgType,
    msgId,
    fromUser,
    chatType,
    chatId,
    responseUrl,
    content,
    imageUrls: dedupeUrlList(imageUrls),
    fileUrl,
    fileName,
    voiceUrl,
    voiceMediaId,
    voiceContentType,
    feedbackId,
    quote,
    isGroupChat: chatType === "group" || Boolean(chatId),
  };
}

export function describeWecomBotParsedMessage(parsed) {
  if (!parsed || typeof parsed !== "object") return "unknown";
  if (parsed.kind === "message") {
    const imageCount = Array.isArray(parsed.imageUrls) ? parsed.imageUrls.length : 0;
    const imageSuffix = imageCount > 0 ? ` images=${imageCount}` : "";
    return `message msgType=${parsed.msgType || "unknown"} from=${parsed.fromUser || "unknown"} msgId=${parsed.msgId || "n/a"}${imageSuffix}`;
  }
  if (parsed.kind === "stream-refresh") {
    return `stream-refresh streamId=${parsed.streamId || "unknown"}`;
  }
  if (parsed.kind === "unsupported") {
    return `unsupported msgType=${parsed.msgType || "unknown"} from=${parsed.fromUser || "unknown"} msgId=${parsed.msgId || "n/a"}`;
  }
  if (parsed.kind === "invalid") {
    return `invalid reason=${parsed.reason || "unknown"} msgType=${parsed.msgType || "unknown"} msgId=${parsed.msgId || "n/a"}`;
  }
  if (parsed.kind === "event") {
    return `event eventType=${parsed.eventType || "unknown"} from=${parsed.fromUser || "unknown"}`;
  }
  return parsed.kind || "unknown";
}

export function extractWecomXmlInboundEnvelope(msgObj) {
  if (!msgObj || typeof msgObj !== "object") return null;
  return {
    msgType: normalizeLowerToken(msgObj.MsgType),
    fromUser: normalizeToken(msgObj.FromUserName),
    chatId: normalizeToken(msgObj.ChatId),
    msgId: normalizeToken(msgObj.MsgId),
    content: normalizeToken(msgObj.Content),
    mediaId: normalizeToken(msgObj.MediaId),
    picUrl: normalizeToken(msgObj.PicUrl),
    recognition: normalizeToken(msgObj.Recognition),
    thumbMediaId: normalizeToken(msgObj.ThumbMediaId),
    fileName: normalizeToken(msgObj.FileName),
    fileSize: normalizeToken(msgObj.FileSize),
    linkTitle: normalizeToken(msgObj.Title),
    linkDescription: normalizeToken(msgObj.Description),
    linkUrl: normalizeToken(msgObj.Url),
    linkPicUrl: normalizeToken(msgObj.PicUrl),
  };
}
