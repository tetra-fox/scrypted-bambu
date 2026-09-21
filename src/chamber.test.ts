import assert from "node:assert/strict";
import { test } from "node:test";

import { FrameParser, authPacket } from "./chamber.ts";

const frame = (jpeg: Buffer) => {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(jpeg.length, 0);
  return Buffer.concat([header, jpeg]);
};

const jpegA = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const jpegB = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 0xff, 0xd9]);

test("auth packet layout", () => {
  const p = authPacket("33569522");
  assert.equal(p.length, 80);
  assert.equal(p.readUInt32LE(0), 0x40);
  assert.equal(p.readUInt32LE(4), 0x3000);
  assert.equal(p.readUInt32LE(8), 0);
  assert.equal(p.readUInt32LE(12), 0);
  assert.equal(p.subarray(16, 48).toString("ascii"), "bblp".padEnd(32, "\0"));
  assert.equal(p.subarray(48, 80).toString("ascii"), "33569522".padEnd(32, "\0"));
});

test("two frames in one chunk", () => {
  const parser = new FrameParser();
  const frames = parser.push(Buffer.concat([frame(jpegA), frame(jpegB)]));
  assert.deepEqual(frames, [jpegA, jpegB]);
});

test("frame split across chunks at every byte boundary", () => {
  const wire = Buffer.concat([frame(jpegA), frame(jpegB)]);
  for (let split = 1; split < wire.length; split++) {
    const parser = new FrameParser();
    const frames = [...parser.push(wire.subarray(0, split)), ...parser.push(wire.subarray(split))];
    assert.deepEqual(frames, [jpegA, jpegB], `split at ${split}`);
  }
});

test("one byte at a time", () => {
  const parser = new FrameParser();
  const frames: Buffer[] = [];
  for (const byte of frame(jpegA)) frames.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(frames, [jpegA]);
});

test("rejects a payload that is not a jpeg", () => {
  const parser = new FrameParser();
  assert.throws(() => parser.push(frame(Buffer.from([1, 2, 3, 4]))), /not a jpeg/);
});

test("rejects an impossible header length", () => {
  const parser = new FrameParser();
  assert.throws(() => parser.push(frame(Buffer.alloc(0))), /out of sync/);
});
