import assert from "node:assert/strict";
import test from "node:test";

import { createWecomAgentReplyDeliverer } from "../src/wecom/outbound-agent-delivery.js";

test("deliverAgentReply uses markdown and FILE directives when configured", async () => {
  const markdownCalls = [];
  const textCalls = [];
  const mediaCalls = [];

  const deliverAgentReply = createWecomAgentReplyDeliverer({
    getWecomConfig: () => ({
      accountId: "default",
      corpId: "ww1",
      corpSecret: "secret",
      agentId: "1000002",
      outboundProxy: "",
      apiBaseUrl: "",
    }),
    sendWecomText: async (payload) => {
      textCalls.push(payload);
    },
    sendWecomMarkdown: async (payload) => {
      markdownCalls.push(payload);
    },
    sendWecomOutboundMediaBatch: async (payload) => {
      mediaCalls.push(payload);
      return { sentCount: 1, failed: [] };
    },
    resolveWecomReasoningPolicy: () => ({
      mode: "separate",
      title: "思考过程",
      maxChars: 1200,
    }),
    resolveWecomReplyFormatPolicy: () => ({
      mode: "markdown",
    }),
    resolveWorkspacePathToHost: ({ workspacePath, agentId }) =>
      workspacePath === "/workspace/out/report.pdf" && agentId === "agent-sales"
        ? "/tmp/agent-sales/report.pdf"
        : "",
    createDeliveryTraceId: () => "trace-agent",
  });

  const result = await deliverAgentReply({
    api: { logger: { info() {}, warn() {}, error() {} } },
    fromUser: "dingxiang",
    sessionId: "agent:main",
    routeAgentId: "agent-sales",
    text: "plain fallback",
    rawText: "## 周报\nFILE: /workspace/out/report.pdf",
  });

  assert.equal(result.ok, true);
  assert.equal(markdownCalls.length, 1);
  assert.equal(textCalls.length, 0);
  assert.equal(markdownCalls[0].content, "## 周报");
  assert.equal(mediaCalls.length, 1);
  assert.deepEqual(mediaCalls[0].mediaItems, [
    {
      url: "/tmp/agent-sales/report.pdf",
      mediaType: "file",
      source: "directive",
    },
  ]);
});
