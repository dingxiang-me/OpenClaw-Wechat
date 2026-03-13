import assert from "node:assert/strict";
import test from "node:test";

import { createWecomApiClient } from "../src/wecom/api-client.js";

function createJsonResponse(payload, { ok = true, contentType = "application/json" } = {}) {
  return {
    ok,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-type") return contentType;
        return "";
      },
    },
    async json() {
      return payload;
    },
    clone() {
      return {
        async json() {
          return payload;
        },
      };
    },
  };
}

function createPassThroughLimiter() {
  return {
    async execute(fn) {
      return fn();
    },
  };
}

function createClient(overrides = {}) {
  const fetchCalls = [];
  const fakeProxyInstances = [];
  const fetchImpl = overrides.fetchImpl || (async (url) => {
    fetchCalls.push({ url: String(url) });
    if (String(url).includes("/gettoken?")) {
      return createJsonResponse({ errcode: 0, access_token: "token-1", expires_in: 7200 });
    }
    return createJsonResponse({ errcode: 0, msgid: "m-1" });
  });

  class FakeProxyAgent {
    constructor(url) {
      this.url = url;
      fakeProxyInstances.push(url);
    }
  }

  const client = createWecomApiClient({
    fetchImpl,
    proxyAgentCtor: FakeProxyAgent,
    sleep: async () => {},
    splitWecomText: (text) => [String(text ?? "")],
    getByteLength: (text) => Buffer.byteLength(String(text ?? ""), "utf8"),
    apiLimiter: createPassThroughLimiter(),
    ...overrides,
  });

  return { client, fetchCalls, fakeProxyInstances };
}

test("buildWecomMessageSendRequest supports app chat and direct targets", () => {
  const { client } = createClient();

  const direct = client.buildWecomMessageSendRequest({
    accessToken: "access-token",
    agentId: "1000002",
    toUser: "alice",
    msgType: "text",
    payload: { text: { content: "hello" } },
  });
  assert.match(direct.sendUrl, /\/cgi-bin\/message\/send\?access_token=access-token/);
  assert.equal(direct.body.touser, "alice");
  assert.equal(direct.body.agentid, "1000002");
  assert.equal(direct.isAppChat, false);

  const appChat = client.buildWecomMessageSendRequest({
    accessToken: "access-token",
    agentId: "1000002",
    chatId: "chat-1",
    msgType: "text",
    payload: { text: { content: "hello" } },
  });
  assert.match(appChat.sendUrl, /\/cgi-bin\/appchat\/send\?access_token=access-token/);
  assert.equal(appChat.body.chatid, "chat-1");
  assert.equal(appChat.body.agentid, undefined);
  assert.equal(appChat.isAppChat, true);
});

test("buildWecomMessageSendRequest replaces WeCom host with apiProxy", () => {
  const { client } = createClient();

  const direct = client.buildWecomMessageSendRequest({
    accessToken: "access-token",
    agentId: "1000002",
    toUser: "alice",
    msgType: "text",
    payload: { text: { content: "hello" } },
    apiProxy: "https://wecom-proxy.example.com/custom",
  });

  assert.equal(
    direct.sendUrl,
    "https://wecom-proxy.example.com/custom/cgi-bin/message/send?access_token=access-token",
  );
});

test("attachWecomProxyDispatcher attaches dispatcher for wecom api or forced proxy", () => {
  const { client, fakeProxyInstances } = createClient();

  const wecomOptions = client.attachWecomProxyDispatcher(
    "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
    {},
    { proxyUrl: "http://127.0.0.1:8080" },
  );
  assert.ok(wecomOptions.dispatcher);
  assert.equal(fakeProxyInstances.length, 1);

  const skipped = client.attachWecomProxyDispatcher("https://example.com/api", {}, { proxyUrl: "http://127.0.0.1:8080" });
  assert.equal(skipped.dispatcher, undefined);

  const forced = client.attachWecomProxyDispatcher(
    "https://example.com/api",
    { forceProxy: true },
    { proxyUrl: "http://127.0.0.1:8080" },
  );
  assert.ok(forced.dispatcher);
  assert.equal(fakeProxyInstances.length, 1);
});

test("getWecomAccessToken caches token per corpId and corpSecret", async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/gettoken?")) {
      tokenCalls += 1;
      return createJsonResponse({ errcode: 0, access_token: "cached-token", expires_in: 7200 });
    }
    return createJsonResponse({ errcode: 0 });
  };

  const { client } = createClient({ fetchImpl });

  const t1 = await client.getWecomAccessToken({
    corpId: "ww-1",
    corpSecret: "secret",
    logger: { info() {}, warn() {}, error() {} },
  });
  const t2 = await client.getWecomAccessToken({
    corpId: "ww-1",
    corpSecret: "secret",
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(t1, "cached-token");
  assert.equal(t2, "cached-token");
  assert.equal(tokenCalls, 1);
});

test("getWecomAccessToken does not reuse token across different corp secrets", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("/gettoken?")) {
      const parsed = new URL(String(url));
      const corpSecret = parsed.searchParams.get("corpsecret");
      calls.push(corpSecret);
      return createJsonResponse({ errcode: 0, access_token: `token-${corpSecret}`, expires_in: 7200 });
    }
    return createJsonResponse({ errcode: 0 });
  };

  const { client } = createClient({ fetchImpl });

  const t1 = await client.getWecomAccessToken({
    corpId: "ww-1",
    corpSecret: "secret-a",
    logger: { info() {}, warn() {}, error() {} },
  });
  const t2 = await client.getWecomAccessToken({
    corpId: "ww-1",
    corpSecret: "secret-b",
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(t1, "token-secret-a");
  assert.equal(t2, "token-secret-b");
  assert.deepEqual(calls, ["secret-a", "secret-b"]);
});

test("sendWecomText splits chunks and sends each chunk", async () => {
  const sentBodies = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/gettoken?")) {
      return createJsonResponse({ errcode: 0, access_token: "token-1", expires_in: 7200 });
    }
    if (String(url).includes("/message/send")) {
      sentBodies.push(JSON.parse(String(options.body ?? "{}")));
      return createJsonResponse({ errcode: 0, msgid: `m-${sentBodies.length}` });
    }
    return createJsonResponse({ errcode: 0 });
  };

  const { client } = createClient({
    fetchImpl,
    splitWecomText: () => ["part-1", "part-2"],
  });

  await client.sendWecomText({
    corpId: "ww-1",
    corpSecret: "secret",
    agentId: "1000002",
    toUser: "alice",
    text: "ignored-by-split",
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[0]?.text?.content, "part-1");
  assert.equal(sentBodies[1]?.text?.content, "part-2");
});

test("downloadWecomMedia returns binary payload", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/gettoken?")) {
      return createJsonResponse({ errcode: 0, access_token: "token-1", expires_in: 7200 });
    }
    if (String(url).includes("/media/get")) {
      return {
        ok: true,
        headers: {
          get(name) {
            if (String(name).toLowerCase() === "content-type") return "image/png";
            return "";
          },
        },
        async arrayBuffer() {
          return Uint8Array.from([1, 2, 3, 4]).buffer;
        },
        async json() {
          return { errcode: 0 };
        },
      };
    }
    return createJsonResponse({ errcode: 0 });
  };

  const { client } = createClient({ fetchImpl });
  const result = await client.downloadWecomMedia({
    corpId: "ww-1",
    corpSecret: "secret",
    mediaId: "m-1",
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(result.contentType, "image/png");
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(result.buffer.length, 4);
});
