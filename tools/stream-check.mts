import { spawn } from "node:child_process";

import { ChamberClient } from "../src/chamber.ts";
import { FrameFeed } from "../src/feed.ts";
import {
  chamberInputArguments,
  DEFAULT_ENCODER_ARGUMENTS,
  splitArguments
} from "../src/pipeline.ts";

const [host, accessCode, seconds = "12"] = process.argv.slice(2);
if (!host || !accessCode) {
  console.error("usage: node tools/stream-check.mts <host> <access code> [seconds]");
  process.exit(2);
}

const feed = new FrameFeed((count) => console.log(`feed clients: ${count}`));
const client = new ChamberClient(host, accessCode, console);
client.on("frame", (frame) => feed.push(frame));
client.start();

const url = `http://127.0.0.1:${await feed.listen()}/`;
// rebroadcast's default input prefix
const args = [
  "-hide_banner",
  "-loglevel",
  "warning",
  "-nostats",
  "-fflags",
  "+genpts",
  ...chamberInputArguments(url),
  ...splitArguments(DEFAULT_ENCODER_ARGUMENTS),
  "-progress",
  "pipe:1",
  "-f",
  "null",
  "/dev/null"
];
console.log("ffmpeg", args.join(" "));
const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "inherit"] });

const progress: Record<string, string> = {};
ffmpeg.stdout.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString().split("\n")) {
    const [key, value] = line.split("=");
    if (key && value !== undefined) progress[key.trim()] = value.trim();
  }
});

const started = Date.now();
setTimeout(() => ffmpeg.kill("SIGINT"), Number(seconds) * 1000);
// progress is flushed on exit
ffmpeg.on("close", () => {
  console.log(
    `after ${((Date.now() - started) / 1000).toFixed(1)}s wall: frames=${progress.frame} out_time=${progress.out_time}`
  );
  client.stop();
  feed.close();
});
