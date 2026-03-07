import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { WecomStreamManager } from "../src/core/stream-manager.js";

test("WecomStreamManager finish stores normalized image msg_item", () => {
  const manager = new WecomStreamManager({ expireMs: 60 * 1000, maxBytes: 20480 });
  manager.create("stream-1", "处理中");

  const validBuffer = Buffer.from("image-binary");
  const validMd5 = crypto.createHash("md5").update(validBuffer).digest("hex");
  const stream = manager.finish("stream-1", "已完成", {
    msgItem: [
      {
        msgtype: "image",
        image: {
          base64: validBuffer.toString("base64"),
          md5: validMd5,
        },
      },
      {
        msgtype: "image",
        image: {
          base64: "",
          md5: "123",
        },
      },
      {
        msgtype: "text",
        text: {
          content: "not-supported",
        },
      },
    ],
  });

  assert.equal(stream?.finished, true);
  assert.equal(stream?.msgItem?.length, 1);
  assert.equal(stream?.msgItem?.[0]?.msgtype, "image");
  assert.equal(stream?.msgItem?.[0]?.image?.md5, validMd5);
});

test("WecomStreamManager update can replace msg_item", () => {
  const manager = new WecomStreamManager({ expireMs: 60 * 1000, maxBytes: 20480 });
  manager.create("stream-2", "处理中");

  const imageBuffer = Buffer.from("image-2");
  const md5 = crypto.createHash("md5").update(imageBuffer).digest("hex");

  manager.update("stream-2", "第一轮", {
    msgItem: [
      {
        msgtype: "image",
        image: {
          base64: imageBuffer.toString("base64"),
          md5,
        },
      },
    ],
  });
  manager.finish("stream-2", "结束");

  const stream = manager.get("stream-2");
  assert.equal(stream?.msgItem?.length, 1);
  assert.equal(stream?.msgItem?.[0]?.image?.md5, md5);
});

test("WecomStreamManager stores thinkingContent on update and finish", () => {
  const manager = new WecomStreamManager({ expireMs: 60 * 1000, maxBytes: 20480 });
  manager.create("stream-think", "处理中");

  manager.update("stream-think", "Visible 1", {
    thinkingContent: "Thinking 1",
  });
  assert.equal(manager.get("stream-think")?.thinkingContent, "Thinking 1");

  manager.finish("stream-think", "Visible 2", {
    thinkingContent: "Thinking 2",
  });
  const stream = manager.get("stream-think");
  assert.equal(stream?.content, "Visible 2");
  assert.equal(stream?.thinkingContent, "Thinking 2");
});

test("WecomStreamManager queues and drains media per stream", () => {
  const manager = new WecomStreamManager({ expireMs: 60 * 1000, maxBytes: 20480 });
  manager.create("stream-3", "处理中");

  assert.equal(
    manager.queueMedia("stream-3", "https://example.com/a.png", { mediaType: "image" }),
    true,
  );
  assert.equal(
    manager.queueMedia("stream-3", "https://example.com/a.png", { mediaType: "image" }),
    true,
  );
  assert.equal(
    manager.queueMedia("stream-3", "https://example.com/b.mp4", { mediaType: "video" }),
    true,
  );

  const drained = manager.drainQueuedMedia("stream-3");
  assert.equal(drained.length, 2);
  assert.equal(drained[0].url, "https://example.com/a.png");
  assert.equal(drained[0].mediaType, "image");
  assert.equal(drained[1].url, "https://example.com/b.mp4");
  assert.equal(drained[1].mediaType, "video");

  assert.deepEqual(manager.drainQueuedMedia("stream-3"), []);
});
