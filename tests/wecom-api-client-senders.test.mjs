import assert from "node:assert/strict";
import test from "node:test";

import { createWecomApiSenders } from "../src/wecom/api-client-senders.js";

function createPassThroughLimiter() {
  return {
    async execute(fn) {
      return fn();
    },
  };
}

test("createWecomApiSenders sendWecomText sends split chunks in order", async () => {
  const sentBodies = [];
  const buildCalls = [];
  const senders = createWecomApiSenders({
    sleep: async () => {},
    splitWecomText: () => ["part-1", "part-2"],
    getByteLength: (text) => Buffer.byteLength(String(text ?? ""), "utf8"),
    apiLimiter: createPassThroughLimiter(),
    fetchWithRetry: async (_url, options = {}) => {
      sentBodies.push(JSON.parse(String(options.body ?? "{}")));
      return {
        async json() {
          return { errcode: 0, msgid: `m-${sentBodies.length}` };
        },
      };
    },
    getWecomAccessToken: async () => "token-1",
    buildWecomMessageSendRequest: ({ msgType, payload, apiProxy }) => {
      buildCalls.push(apiProxy);
      return {
      sendUrl: "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=token-1",
      body: {
        msgtype: msgType,
        ...payload,
      },
      isAppChat: false,
      };
    },
  });

  await senders.sendWecomText({
    corpId: "ww-1",
    corpSecret: "secret",
    agentId: "1000002",
    toUser: "alice",
    text: "ignored",
    apiProxy: "https://wecom-proxy.example.com",
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[0]?.text?.content, "part-1");
  assert.equal(sentBodies[1]?.text?.content, "part-2");
  assert.deepEqual(buildCalls, ["https://wecom-proxy.example.com", "https://wecom-proxy.example.com"]);
});

test("createWecomApiSenders sendWecomVoice throws typed error on errcode", async () => {
  const senders = createWecomApiSenders({
    sleep: async () => {},
    splitWecomText: (text) => [String(text ?? "")],
    getByteLength: (text) => Buffer.byteLength(String(text ?? ""), "utf8"),
    apiLimiter: createPassThroughLimiter(),
    fetchWithRetry: async () => ({
      async json() {
        return { errcode: 40013, errmsg: "invalid appid" };
      },
    }),
    getWecomAccessToken: async () => "token-1",
    buildWecomMessageSendRequest: ({ msgType, payload }) => ({
      sendUrl: "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=token-1",
      body: {
        msgtype: msgType,
        ...payload,
      },
      isAppChat: false,
    }),
  });

  await assert.rejects(
    () =>
      senders.sendWecomVoice({
        corpId: "ww-1",
        corpSecret: "secret",
        agentId: "1000002",
        toUser: "alice",
        mediaId: "m-voice",
        logger: { info() {}, warn() {}, error() {} },
      }),
    /WeCom voice send failed/,
  );
});
