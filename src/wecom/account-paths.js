function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

export function buildWebhookPathAccountSlug(accountId) {
  const normalizedId = normalizeAccountId(accountId);
  if (normalizedId === "default") return "default";
  const slug = normalizedId.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return slug || "default";
}

export function buildDefaultAgentWebhookPath(accountId) {
  const normalizedId = normalizeAccountId(accountId);
  if (normalizedId === "default") return "/wecom/callback";
  const slug = buildWebhookPathAccountSlug(normalizedId);
  return `/wecom/${slug}/callback`;
}

export function buildDefaultBotWebhookPath(accountId) {
  const normalizedId = normalizeAccountId(accountId);
  if (normalizedId === "default") return "/wecom/bot/callback";
  const slug = buildWebhookPathAccountSlug(normalizedId);
  return `/wecom/${slug}/bot/callback`;
}

