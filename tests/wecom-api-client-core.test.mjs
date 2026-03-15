import assert from "node:assert/strict";
import test from "node:test";

import { createWecomApiClientCore } from "../src/wecom/api-client-core.js";

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

test("createWecomApiClientCore attaches and reuses proxy dispatcher", () => {
  const created = [];
  class FakeProxyAgent {
    constructor(url) {
      this.url = url;
      created.push(url);
    }
  }

  const core = createWecomApiClientCore({
    fetchImpl: async () => createJsonResponse({ errcode: 0 }),
    proxyAgentCtor: FakeProxyAgent,
    sleep: async () => {},
  });

  const first = core.attachWecomProxyDispatcher(
    "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
    {},
    { proxyUrl: "http://127.0.0.1:8080" },
  );
  const second = core.attachWecomProxyDispatcher(
    "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
    {},
    { proxyUrl: "http://127.0.0.1:8080" },
  );

  assert.ok(first.dispatcher);
  assert.equal(second.dispatcher, first.dispatcher);
  assert.equal(created.length, 1);
});

test("createWecomApiClientCore caches access token by corpId and corpSecret", async () => {
  let tokenCalls = 0;
  const core = createWecomApiClientCore({
    fetchImpl: async (url) => {
      if (String(url).includes("/gettoken?")) {
        tokenCalls += 1;
        return createJsonResponse({ errcode: 0, access_token: "token-core", expires_in: 7200 });
      }
      return createJsonResponse({ errcode: 0 });
    },
    proxyAgentCtor: class FakeProxyAgent {},
    sleep: async () => {},
  });

  const token1 = await core.getWecomAccessToken({
    corpId: "ww-core",
    corpSecret: "secret",
    logger: { info() {}, warn() {}, error() {} },
  });
  const token2 = await core.getWecomAccessToken({
    corpId: "ww-core",
    corpSecret: "secret",
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(token1, "token-core");
  assert.equal(token2, "token-core");
  assert.equal(tokenCalls, 1);
});

test("createWecomApiClientCore supports custom api base url for proxy attach and token fetch", async () => {
  const requests = [];
  const core = createWecomApiClientCore({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), dispatcher: options.dispatcher });
      return createJsonResponse({ errcode: 0, access_token: "token-custom", expires_in: 7200 });
    },
    proxyAgentCtor: class FakeProxyAgent {
      constructor(url) {
        this.url = url;
      }
    },
    sleep: async () => {},
  });

  const attached = core.attachWecomProxyDispatcher(
    "https://wecom.internal/cgi-bin/gettoken",
    { apiBaseUrl: "https://wecom.internal" },
    { proxyUrl: "http://127.0.0.1:8080" },
  );
  assert.ok(attached.dispatcher);

  const token = await core.getWecomAccessToken({
    corpId: "ww-core",
    corpSecret: "secret",
    apiBaseUrl: "https://wecom.internal",
    proxyUrl: "http://127.0.0.1:8080",
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(token, "token-custom");
  assert.match(requests[0]?.url ?? "", /^https:\/\/wecom\.internal\/cgi-bin\/gettoken\?/);
});

test("createWecomApiClientCore isolates access token cache across secrets in the same corp", async () => {
  const calls = [];
  const core = createWecomApiClientCore({
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      const corpSecret = parsed.searchParams.get("corpsecret");
      calls.push(corpSecret);
      return createJsonResponse({ errcode: 0, access_token: `token-${corpSecret}`, expires_in: 7200 });
    },
    proxyAgentCtor: class FakeProxyAgent {},
    sleep: async () => {},
  });

  const tokenA = await core.getWecomAccessToken({
    corpId: "ww-core",
    corpSecret: "secret-a",
    logger: { info() {}, warn() {}, error() {} },
  });
  const tokenB = await core.getWecomAccessToken({
    corpId: "ww-core",
    corpSecret: "secret-b",
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(tokenA, "token-secret-a");
  assert.equal(tokenB, "token-secret-b");
  assert.deepEqual(calls, ["secret-a", "secret-b"]);
});
