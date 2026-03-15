import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import {
  createWecomReliableDeliveryPersistence,
  resolveWecomReliableDeliveryStoreFile,
} from "../src/wecom/reliable-delivery-persistence.js";
import { createWecomReliableDeliveryStore } from "../src/wecom/reliable-delivery.js";

test("resolveWecomReliableDeliveryStoreFile prefers explicit pending reply store file", () => {
  const storeFile = resolveWecomReliableDeliveryStoreFile(
    { state: { dir: "/tmp/openclaw-state" } },
    { storeFile: "/tmp/custom-reliable-delivery.json" },
  );
  assert.equal(storeFile, "/tmp/custom-reliable-delivery.json");
});

test("reliable delivery persistence writes and restores pending replies", async () => {
  let now = 1_700_000_000_000;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-reliable-delivery-"));
  const storeFile = path.join(tempDir, "reliable-delivery.json");
  const runtime = {
    config: {
      state: { dir: tempDir },
    },
  };

  const createPersistence = (store) =>
    createWecomReliableDeliveryPersistence({
      reliableDeliveryStore: store,
      resolveWecomPendingReplyPolicy: () => ({
        enabled: true,
        persist: true,
        storeFile,
      }),
      getGatewayRuntime: () => runtime,
      now: () => now,
      debounceMs: 10,
    });

  const sourceStore = createWecomReliableDeliveryStore({
    now: () => now,
  });
  sourceStore.markInboundActivity({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:alice",
    fromUser: "alice",
  });
  sourceStore.enqueuePendingReply({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:alice",
    fromUser: "alice",
    payload: {
      text: "补发消息",
    },
    reason: "fetch failed",
    deliveryStatus: "rejected_transport",
  });
  const writer = createPersistence(sourceStore);
  await writer.persistNow("test-write", { config: runtime.config });

  const raw = JSON.parse(await readFile(storeFile, "utf8"));
  assert.equal(Array.isArray(raw?.pending), true);
  assert.equal(raw.pending.length, 1);

  const restoredStore = createWecomReliableDeliveryStore({
    now: () => now,
  });
  const reader = createPersistence(restoredStore);
  await reader.ensureLoaded({ config: runtime.config });

  const pending = restoredStore.listPendingRepliesForSession({
    mode: "agent",
    accountId: "default",
    sessionId: "wecom:alice",
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.text, "补发消息");
});
