import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveOpenClawStateDir } from "./workspace-state.js";

function normalizePath(value) {
  return String(value ?? "").trim();
}

export function resolveWecomReliableDeliveryStoreFile(
  cfg,
  pendingReplyPolicy = {},
  { processEnv = process.env, joinFn = join } = {},
) {
  const explicit = normalizePath(pendingReplyPolicy?.storeFile);
  if (explicit) return explicit;
  const stateDir = resolveOpenClawStateDir(cfg, { processEnv, joinFn });
  return joinFn(stateDir, "wecom", "reliable-delivery.json");
}

export function createWecomReliableDeliveryPersistence({
  reliableDeliveryStore,
  resolveWecomPendingReplyPolicy,
  getGatewayRuntime,
  processEnv = process.env,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  renameImpl = rename,
  now = () => Date.now(),
  debounceMs = 300,
  logger = null,
} = {}) {
  if (!reliableDeliveryStore || typeof reliableDeliveryStore !== "object") {
    throw new Error("createWecomReliableDeliveryPersistence: reliableDeliveryStore is required");
  }
  if (typeof resolveWecomPendingReplyPolicy !== "function") {
    throw new Error("createWecomReliableDeliveryPersistence: resolveWecomPendingReplyPolicy is required");
  }
  if (typeof getGatewayRuntime !== "function") {
    throw new Error("createWecomReliableDeliveryPersistence: getGatewayRuntime is required");
  }

  let loaded = false;
  let loadPromise = null;
  let persistTimer = null;
  let persistPromise = Promise.resolve();
  let lastApi = null;

  function resolveRuntimeApi(api) {
    return api && typeof api === "object" ? api : lastApi;
  }

  function resolveConfig(api) {
    const runtime = getGatewayRuntime();
    return api?.config ?? runtime?.config ?? {};
  }

  function resolvePolicy(api) {
    const resolvedApi = resolveRuntimeApi(api);
    return resolveWecomPendingReplyPolicy(resolvedApi);
  }

  function resolveStorePath(api) {
    return resolveWecomReliableDeliveryStoreFile(resolveConfig(api), resolvePolicy(api), {
      processEnv,
    });
  }

  async function persistNow(reason = "manual", api = null) {
    const resolvedApi = resolveRuntimeApi(api);
    const policy = resolvePolicy(resolvedApi);
    if (policy?.enabled !== true || policy?.persist === false) return null;
    const storePath = resolveStorePath(resolvedApi);
    const snapshot = reliableDeliveryStore.exportState({ at: now() });
    const normalizedPath = normalizePath(storePath);
    if (!normalizedPath) return null;

    persistPromise = persistPromise.then(async () => {
      const tempPath = `${normalizedPath}.tmp-${now()}`;
      await mkdirImpl(dirname(normalizedPath), { recursive: true });
      await writeFileImpl(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await renameImpl(tempPath, normalizedPath);
      logger?.debug?.(`wecom: persisted reliable delivery state reason=${reason} path=${normalizedPath}`);
      return normalizedPath;
    });
    return persistPromise;
  }

  function schedulePersist(reason = "change", api = null) {
    const resolvedApi = resolveRuntimeApi(api);
    const policy = resolvePolicy(resolvedApi);
    if (policy?.enabled !== true || policy?.persist === false) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void persistNow(reason, resolvedApi);
    }, Math.max(50, Number(debounceMs) || 300));
    persistTimer.unref?.();
  }

  async function ensureLoaded(api = null) {
    const resolvedApi = resolveRuntimeApi(api);
    if (resolvedApi) lastApi = resolvedApi;
    if (loaded) return true;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      const policy = resolvePolicy(resolvedApi);
      if (policy?.enabled !== true || policy?.persist === false) {
        loaded = true;
        return true;
      }
      const storePath = resolveStorePath(resolvedApi);
      try {
        const raw = await readFileImpl(storePath, "utf8");
        const parsed = JSON.parse(raw);
        reliableDeliveryStore.hydrateState(parsed, { at: now() });
      } catch (err) {
        if (err?.code !== "ENOENT") {
          logger?.warn?.(`wecom: failed to load reliable delivery state: ${String(err?.message || err)}`);
        }
      }
      loaded = true;
      return true;
    })();

    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  return {
    ensureLoaded,
    schedulePersist,
    persistNow,
  };
}
