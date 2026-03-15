function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomWebhookBotDeliverer: ${name} is required`);
  }
}

export function createWecomWebhookBotDeliverer({
  attachWecomProxyDispatcher,
  resolveWebhookBotSendUrl,
  webhookSendText,
  webhookSendMarkdown,
  webhookSendTemplateCard,
  sendWebhookBotMediaBatch,
  fetchImpl = fetch,
} = {}) {
  assertFunction("attachWecomProxyDispatcher", attachWecomProxyDispatcher);
  assertFunction("resolveWebhookBotSendUrl", resolveWebhookBotSendUrl);
  assertFunction("webhookSendText", webhookSendText);
  assertFunction("webhookSendMarkdown", webhookSendMarkdown);
  assertFunction("webhookSendTemplateCard", webhookSendTemplateCard);
  assertFunction("sendWebhookBotMediaBatch", sendWebhookBotMediaBatch);
  assertFunction("fetchImpl", fetchImpl);

  return async function deliverWebhookBotReply({
    api,
    webhookBotPolicy,
    botProxyUrl = "",
    content = "",
    richContent = "",
    replyFormatMode = "auto",
    fallbackText = "",
    normalizedText = "",
    normalizedMediaUrls = [],
    normalizedMediaItems = [],
    mediaType,
    cardPayload = null,
    cardPolicy = {},
  } = {}) {
    if (!webhookBotPolicy?.enabled) {
      return { ok: false, reason: "webhook-bot-disabled" };
    }
    const sendUrl = resolveWebhookBotSendUrl({
      url: webhookBotPolicy?.url,
      key: webhookBotPolicy?.key,
    });
    if (!sendUrl) {
      return { ok: false, reason: "webhook-bot-url-missing" };
    }

    const dispatcher = attachWecomProxyDispatcher(sendUrl, {}, { proxyUrl: botProxyUrl, logger: api?.logger })?.dispatcher;
    const textPayload = `${content || fallbackText}`.trim();
    const markdownPayload = String(richContent || content || fallbackText).trim();
    let sentAny = false;
    let usedCardMode = "";

    const cardEnabledForWebhook = cardPolicy?.enabled === true && cardPolicy?.webhookBotEnabled !== false;
    const canTryCard = cardEnabledForWebhook && normalizedMediaUrls.length === 0 && cardPayload && typeof cardPayload === "object";
    if (canTryCard) {
      try {
        const cardMsgType = String(cardPayload?.msgtype ?? "").trim().toLowerCase();
        if (cardMsgType === "template_card" && cardPayload?.template_card) {
          await webhookSendTemplateCard({
            url: webhookBotPolicy?.url,
            key: webhookBotPolicy?.key,
            templateCard: cardPayload.template_card,
            timeoutMs: webhookBotPolicy?.timeoutMs,
            dispatcher,
            fetchImpl,
          });
          sentAny = true;
          usedCardMode = "template_card";
        } else if (cardMsgType === "markdown" && cardPayload?.markdown?.content) {
          await webhookSendMarkdown({
            url: webhookBotPolicy?.url,
            key: webhookBotPolicy?.key,
            content: String(cardPayload.markdown.content ?? ""),
            timeoutMs: webhookBotPolicy?.timeoutMs,
            dispatcher,
            fetchImpl,
          });
          sentAny = true;
          usedCardMode = "markdown";
        }
      } catch (err) {
        api?.logger?.warn?.(`wecom: webhook bot card send failed, fallback to text: ${String(err?.message || err)}`);
      }
    }

    const preferMarkdown = String(replyFormatMode ?? "").trim().toLowerCase() === "markdown";
    if (!sentAny && preferMarkdown && markdownPayload && normalizedMediaUrls.length === 0) {
      await webhookSendMarkdown({
        url: webhookBotPolicy?.url,
        key: webhookBotPolicy?.key,
        content: markdownPayload,
        timeoutMs: webhookBotPolicy?.timeoutMs,
        dispatcher,
        fetchImpl,
      });
      sentAny = true;
      usedCardMode = "markdown";
    }

    if (!sentAny && textPayload && (normalizedText || normalizedMediaUrls.length === 0)) {
      await webhookSendText({
        url: webhookBotPolicy?.url,
        key: webhookBotPolicy?.key,
        content: textPayload,
        timeoutMs: webhookBotPolicy?.timeoutMs,
        dispatcher,
        fetchImpl,
      });
      sentAny = true;
    }

    let mediaMeta = { sentCount: 0, failedCount: 0, failedUrls: [] };
    if (normalizedMediaUrls.length > 0) {
      mediaMeta = await sendWebhookBotMediaBatch({
        api,
        webhookBotPolicy,
        proxyUrl: botProxyUrl,
        mediaUrls: normalizedMediaUrls,
        mediaItems: normalizedMediaItems,
        mediaType,
      });
      sentAny = sentAny || mediaMeta.sentCount > 0;
    }

    if (!sentAny) {
      return { ok: false, reason: mediaMeta.reason || "webhook-bot-send-failed" };
    }

    if (mediaMeta.failedCount > 0) {
      await webhookSendText({
        url: webhookBotPolicy?.url,
        key: webhookBotPolicy?.key,
        content: `以下媒体回传失败，已自动降级为链接：\n${mediaMeta.failedUrls.join("\n")}`,
        timeoutMs: webhookBotPolicy?.timeoutMs,
        dispatcher,
        fetchImpl,
      });
    }

    return {
      ok: true,
      meta: {
        mediaSent: mediaMeta.sentCount,
        mediaFailed: mediaMeta.failedCount,
        cardMode: usedCardMode || undefined,
      },
    };
  };
}
