import { writeFileSync } from "node:fs";

import { ChamberClient } from "../src/chamber.ts";

const [host, accessCode, count = "3"] = process.argv.slice(2);
if (!host || !accessCode) {
  console.error("usage: node tools/chamber-probe.mts <host> <access code> [frames]");
  process.exit(2);
}
const client = new ChamberClient(host, accessCode, console);
const started = Date.now();
let n = 0;
client.on("frame", (frame) => {
  n++;
  console.log(
    `frame ${n}: ${frame.length} bytes at +${((Date.now() - started) / 1000).toFixed(2)}s`
  );
  if (n === 1) writeFileSync("/tmp/chamber-probe.jpg", frame);
  if (n >= Number(count)) {
    client.stop();
    console.log("saved first frame to /tmp/chamber-probe.jpg");
  }
});
client.start();
