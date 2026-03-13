import assert from "node:assert/strict";
import test from "node:test";

import { createWecomAgentTextSender } from "../src/wecom/agent-text-sender.js";

test("createWecomAgentTextSender forwards fixed args and text", async () => {
  const calls = [];
  const sendText = createWecomAgentTextSender({
    sendWecomText: async (payload) => {
      calls.push(payload);
      return { ok: true };
    },
    corpId: "ww-1",
    corpSecret: "secret",
    agentId: "1000002",
    toUser: "dingxiang",
    logger: { info() {}, warn() {}, error() {} },
    proxyUrl: "http://127.0.0.1:8080",
    apiProxy: "https://wecom-proxy.example.com",
  });

  await sendText("hello");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].corpId, "ww-1");
  assert.equal(calls[0].corpSecret, "secret");
  assert.equal(calls[0].agentId, "1000002");
  assert.equal(calls[0].toUser, "dingxiang");
  assert.equal(calls[0].proxyUrl, "http://127.0.0.1:8080");
  assert.equal(calls[0].apiProxy, "https://wecom-proxy.example.com");
  assert.equal(calls[0].text, "hello");
});
