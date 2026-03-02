const DEFAULT_FALLBACK_ORDER = Object.freeze([
  "active_stream",
  "response_url",
  "webhook_bot",
  "agent_push",
]);

const SUPPORTED_LAYERS = new Set(DEFAULT_FALLBACK_ORDER);

function normalizeLayerName(layer) {
  const normalized = String(layer ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (!normalized) return "";
  if (normalized === "active" || normalized === "stream") return "active_stream";
  if (normalized === "responseurl") return "response_url";
  if (normalized === "webhook" || normalized === "webhookbot") return "webhook_bot";
  if (normalized === "agent" || normalized === "agentpush") return "agent_push";
  return normalized;
}

function normalizeFallbackOrder(order) {
  const source = Array.isArray(order) ? order : [];
  const deduped = [];
  const seen = new Set();
  for (const item of source) {
    const normalized = normalizeLayerName(item);
    if (!normalized || !SUPPORTED_LAYERS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped.length > 0 ? deduped : Array.from(DEFAULT_FALLBACK_ORDER);
}

function safeErrorMessage(err) {
  if (!err) return "unknown";
  return String(err?.message ?? err).slice(0, 220);
}

function summarizeMeta(meta = {}) {
  const keys = Object.keys(meta);
  if (keys.length === 0) return "";
  const line = keys
    .map((key) => `${key}=${String(meta[key] ?? "").slice(0, 80)}`)
    .join(" ");
  return line.trim();
}

export function normalizeWecomErrcode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

export function parseWecomResponseUrlResult(response, responseBody) {
  const bodyText = typeof responseBody === "string" ? responseBody.trim() : "";
  let parsed = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
  }
  const errcode = normalizeWecomErrcode(parsed?.errcode);
  const errmsg = typeof parsed?.errmsg === "string" ? parsed.errmsg : "";
  return {
    accepted: response?.ok === true && errcode === 0,
    errcode,
    errmsg,
    bodyPreview: bodyText.slice(0, 300),
  };
}

export function createWecomDeliveryRouter({
  logger,
  fallbackConfig = {},
  handlers = {},
  observability = {},
} = {}) {
  const fallbackEnabled = fallbackConfig?.enabled === true;
  const fallbackOrder = normalizeFallbackOrder(fallbackConfig?.order);
  const activeOrder = fallbackEnabled ? fallbackOrder : ["active_stream"];
  const observabilityEnabled = observability?.enabled !== false;
  const logPayloadMeta = observability?.logPayloadMeta !== false;

  async function deliverText({ text, traceId, meta = {} } = {}) {
    const content = String(text ?? "").trim();
    if (!content) {
      return {
        ok: false,
        layer: null,
        attempts: [],
        error: "empty-text",
      };
    }

    const attempts = [];
    const deliverStartedAt = Date.now();
    for (const layer of activeOrder) {
      const handler = handlers?.[layer];
      if (typeof handler !== "function") {
        attempts.push({
          layer,
          ok: false,
          status: "skipped",
          reason: "no-handler",
          durationMs: 0,
          startedAt: Date.now(),
          endedAt: Date.now(),
        });
        continue;
      }

      const layerStartedAt = Date.now();
      try {
        const result = await handler({ text: content, traceId, meta });
        const layerEndedAt = Date.now();
        if (result?.ok) {
          const success = {
            layer,
            ok: true,
            status: "ok",
            meta: result?.meta ?? {},
            durationMs: Math.max(0, layerEndedAt - layerStartedAt),
            startedAt: layerStartedAt,
            endedAt: layerEndedAt,
          };
          attempts.push(success);
          if (observabilityEnabled) {
            const metaLine = logPayloadMeta ? summarizeMeta({ ...meta, ...success.meta }) : "";
            logger?.info?.(
              `wecom(delivery): trace=${traceId || "n/a"} layer=${layer} status=ok${metaLine ? ` ${metaLine}` : ""}`,
            );
          }
          return {
            ok: true,
            layer,
            deliveryPath: layer,
            finalStatus: attempts.length > 1 ? "degraded" : "ok",
            attempts,
            totalDurationMs: Math.max(0, layerEndedAt - deliverStartedAt),
          };
        }
        const failed = {
          layer,
          ok: false,
          status: "miss",
          reason: String(result?.reason ?? "rejected"),
          meta: result?.meta ?? {},
          durationMs: Math.max(0, layerEndedAt - layerStartedAt),
          startedAt: layerStartedAt,
          endedAt: layerEndedAt,
        };
        attempts.push(failed);
        if (observabilityEnabled) {
          logger?.warn?.(
            `wecom(delivery): trace=${traceId || "n/a"} layer=${layer} status=miss reason=${failed.reason}`,
          );
        }
      } catch (err) {
        const layerEndedAt = Date.now();
        const failure = {
          layer,
          ok: false,
          status: "error",
          reason: safeErrorMessage(err),
          durationMs: Math.max(0, layerEndedAt - layerStartedAt),
          startedAt: layerStartedAt,
          endedAt: layerEndedAt,
        };
        attempts.push(failure);
        if (observabilityEnabled) {
          logger?.warn?.(
            `wecom(delivery): trace=${traceId || "n/a"} layer=${layer} status=error reason=${failure.reason}`,
          );
        }
      }
    }

    if (observabilityEnabled) {
      logger?.error?.(
        `wecom(delivery): trace=${traceId || "n/a"} all layers exhausted order=${activeOrder.join(">")}`,
      );
    }
    return {
      ok: false,
      layer: null,
      deliveryPath: null,
      finalStatus: "failed",
      attempts,
      error: "all-layers-failed",
      totalDurationMs: Math.max(0, Date.now() - deliverStartedAt),
    };
  }

  return {
    deliverText,
    fallbackEnabled,
    order: activeOrder,
  };
}
