import assert from "node:assert/strict";
import { get, type IncomingMessage } from "node:http";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { FrameFeed } from "./feed.ts";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

// node only sends the response head with the first body write, so the feed needs a frame
// before a reader connects, the same as when ffmpeg attaches to a running chamber client
const connect = async (feed: FrameFeed) => {
  feed.push(jpeg);
  const port = await feed.listen();
  return new Promise<IncomingMessage>((resolve) => get(`http://127.0.0.1:${port}/`, resolve));
};

// reads the feed for a while and counts the multipart parts it sent
const countParts = async (feed: FrameFeed, ms: number) => {
  const response = await connect(feed);
  let body = "";
  response.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
  await sleep(ms);
  feed.close();
  return body.split("--frame\r\n").length - 1;
};

test("without pacing a reader gets the latest frame once", async () => {
  const parts = await countParts(new FrameFeed(() => {}), 300);
  assert.equal(parts, 1);
});

test("with pacing the latest frame is resent on the interval", async () => {
  const parts = await countParts(new FrameFeed(() => {}, 50), 320);
  // one on connect plus ~6 ticks in 320 ms, allow for timer jitter
  assert.ok(parts >= 5 && parts <= 8, `got ${parts} parts`);
});

test("pacing stops when the last reader leaves", async () => {
  const feed = new FrameFeed(() => {}, 20);
  const response = await connect(feed);
  await sleep(60);
  response.destroy();
  await sleep(40);
  assert.equal((feed as unknown as { pacer?: NodeJS.Timeout }).pacer, undefined);
  feed.close();
});

test("pacing stops once the latest frame is stale", async () => {
  const feed = new FrameFeed(() => {}, 20, 100);
  const response = await connect(feed);
  let body = "";
  response.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
  const parts = () => body.split("--frame\r\n").length - 1;
  await sleep(150);
  const whileFresh = parts();
  await sleep(150);
  feed.close();
  assert.ok(whileFresh >= 3, `got ${whileFresh} parts while the frame was fresh`);
  assert.equal(parts(), whileFresh);
});
