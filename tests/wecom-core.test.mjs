import assert from "node:assert/strict";
import test from "node:test";

import * as core from "../src/core.js";

test("buildWecomSessionId normalizes user id", () => {
  assert.equal(core.buildWecomSessionId(" DingXiang "), "wecom:dingxiang");
  assert.equal(core.buildWecomSessionId(""), "wecom:");
});

test("inbound dedupe keeps first message and rejects duplicate", () => {
  core.resetInboundMessageDedupeForTests();
  const msg = {
    MsgId: "123456",
    FromUserName: "user_a",
    CreateTime: "1700000000",
    MsgType: "text",
    Content: "hello",
  };
  assert.equal(core.markInboundMessageSeen(msg, "default"), true);
  assert.equal(core.markInboundMessageSeen(msg, "default"), false);
  assert.equal(core.markInboundMessageSeen(msg, "other"), true);
});

test("splitWecomText preserves content and stays within byte limit", () => {
  const input = "第一行\n\n第二行 with spaces    \n第三行。".repeat(40);
  const chunks = core.splitWecomText(input, 200);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(core.getByteLength(chunk) <= 200);
  }
  assert.equal(chunks.join(""), input);
});

test("pickAccountBySignature selects account by token", () => {
  const timestamp = "1700000000";
  const nonce = "abc123";
  const encrypt = "cipher_payload";
  const accounts = [
    { accountId: "a", callbackToken: "token-a", callbackAesKey: "aes-a" },
    { accountId: "b", callbackToken: "token-b", callbackAesKey: "aes-b" },
  ];
  const targetSignature = core.computeMsgSignature({
    token: "token-b",
    timestamp,
    nonce,
    encrypt,
  });
  const matched = core.pickAccountBySignature({
    accounts,
    msgSignature: targetSignature,
    timestamp,
    nonce,
    encrypt,
  });
  assert.equal(matched?.accountId, "b");
});
