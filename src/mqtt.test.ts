import assert from "node:assert/strict";
import { test } from "node:test";

import { PacketParser, encodeRemainingLength, parsePublish } from "./mqtt.ts";

test("remaining length encoding at the byte boundaries", () => {
  assert.deepEqual([...encodeRemainingLength(0)], [0]);
  assert.deepEqual([...encodeRemainingLength(127)], [127]);
  assert.deepEqual([...encodeRemainingLength(128)], [0x80, 1]);
  assert.deepEqual([...encodeRemainingLength(16383)], [0xff, 0x7f]);
  assert.deepEqual([...encodeRemainingLength(16384)], [0x80, 0x80, 1]);
});

const publish = (topic: string, payload: string) => {
  const body = Buffer.concat([
    Buffer.from([0, topic.length]),
    Buffer.from(topic),
    Buffer.from(payload)
  ]);
  return Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(body.length), body]);
};

test("a packet longer than 127 bytes split at every byte boundary", () => {
  const wire = Buffer.concat([publish("device/x/report", "a".repeat(300)), publish("t", "b")]);
  for (let split = 1; split < wire.length; split++) {
    const parser = new PacketParser();
    const packets = [...parser.push(wire.subarray(0, split)), ...parser.push(wire.subarray(split))];
    assert.equal(packets.length, 2, `split at ${split}`);
    const [first, second] = packets.map((p) => parsePublish(p.body));
    assert.equal(first.topic, "device/x/report");
    assert.equal(first.payload.length, 300);
    assert.equal(second.payload.toString(), "b");
  }
});

test("connack is passed through with its return code", () => {
  const parser = new PacketParser();
  const [ack] = parser.push(Buffer.from([0x20, 2, 0, 5]));
  assert.equal(ack.type, 2);
  assert.equal(ack.body[1], 5);
});
