import assert from "node:assert/strict";
import test from "node:test";

import { parseThinkingContent } from "../src/wecom/thinking-parser.js";

test("parseThinkingContent returns plain text when no think tags", () => {
  const result = parseThinkingContent("Hello **world**");
  assert.equal(result.visibleContent, "Hello **world**");
  assert.equal(result.thinkingContent, "");
  assert.equal(result.isThinking, false);
});

test("parseThinkingContent extracts closed think block", () => {
  const result = parseThinkingContent("<think>先分析</think>最终答案");
  assert.equal(result.visibleContent, "最终答案");
  assert.equal(result.thinkingContent, "先分析");
  assert.equal(result.isThinking, false);
});

test("parseThinkingContent handles unclosed think block", () => {
  const result = parseThinkingContent("开始<think>还在推理");
  assert.equal(result.visibleContent, "开始");
  assert.equal(result.thinkingContent, "还在推理");
  assert.equal(result.isThinking, true);
});

test("parseThinkingContent ignores think tags inside code", () => {
  const text = "```js\n<think>not real</think>\n```\nVisible";
  const result = parseThinkingContent(text);
  assert.equal(result.visibleContent, text);
  assert.equal(result.thinkingContent, "");
  assert.equal(result.isThinking, false);
});
