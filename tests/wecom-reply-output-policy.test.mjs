import assert from "node:assert/strict";
import test from "node:test";

import {
  extractWecomReplyDirectives,
  normalizeWecomReplyFormatPolicy,
  resolveWecomReplyDirectiveMediaItems,
  selectWecomReplyTextVariant,
} from "../src/wecom/reply-output-policy.js";

test("extractWecomReplyDirectives strips MEDIA and FILE lines from visible text", () => {
  const result = extractWecomReplyDirectives("第一段\nMEDIA: /workspace/out/chart.png\nFILE: /workspace/out/report.pdf\n第二段");
  assert.equal(result.text, "第一段\n第二段");
  assert.deepEqual(result.mediaItems, [
    { url: "/workspace/out/chart.png", mediaType: undefined, source: "directive" },
    { url: "/workspace/out/report.pdf", mediaType: "file", source: "directive" },
  ]);
});

test("resolveWecomReplyDirectiveMediaItems maps workspace paths to host paths", () => {
  const items = resolveWecomReplyDirectiveMediaItems({
    mediaItems: [
      { url: "/workspace/out/chart.png" },
      { url: "/workspace/out/report.pdf", mediaType: "file" },
    ],
    routeAgentId: "agent-sales",
    resolveWorkspacePathToHost: ({ workspacePath, agentId }) =>
      `/tmp/${agentId}${workspacePath.replace("/workspace", "")}`,
  });
  assert.deepEqual(items, [
    { url: "/tmp/agent-sales/out/chart.png", mediaType: undefined, source: "" },
    { url: "/tmp/agent-sales/out/report.pdf", mediaType: "file", source: "" },
  ]);
});

test("selectWecomReplyTextVariant prefers markdown only when supported", () => {
  assert.deepEqual(
    normalizeWecomReplyFormatPolicy({ mode: "MARKDOWN" }),
    { mode: "markdown" },
  );
  const markdown = selectWecomReplyTextVariant({
    plainText: "plain",
    richText: "## rich",
    policy: { mode: "markdown" },
    supportsMarkdown: true,
  });
  assert.equal(markdown.text, "## rich");
  assert.equal(markdown.format, "markdown");

  const fallback = selectWecomReplyTextVariant({
    plainText: "plain",
    richText: "## rich",
    policy: { mode: "markdown" },
    supportsMarkdown: false,
  });
  assert.equal(fallback.text, "plain");
  assert.equal(fallback.format, "text");
});
