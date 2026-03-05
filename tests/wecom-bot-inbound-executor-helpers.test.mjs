import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWecomBotGroupChatPolicy } from "../src/wecom/bot-inbound-executor-helpers.js";

test("normalizeWecomBotGroupChatPolicy forces mention mode for bot group callbacks", () => {
  const policy = normalizeWecomBotGroupChatPolicy({
    enabled: true,
    triggerMode: "direct",
    mentionPatterns: ["@AI助手"],
  });
  assert.equal(policy.enabled, true);
  assert.equal(policy.triggerMode, "mention");
  assert.equal(policy.requireMention, true);
  assert.deepEqual(policy.mentionPatterns, ["@AI助手"]);
});

test("normalizeWecomBotGroupChatPolicy keeps disabled policy disabled", () => {
  const policy = normalizeWecomBotGroupChatPolicy({
    enabled: false,
    triggerMode: "direct",
  });
  assert.equal(policy.enabled, false);
  assert.equal(policy.triggerMode, "direct");
  assert.deepEqual(policy.mentionPatterns, ["@"]);
});
