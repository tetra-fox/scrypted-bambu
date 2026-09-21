import { EventEmitter } from "node:events";
import { connect, type TLSSocket } from "node:tls";

export const CHAMBER_PORT = 6000;
const HEADER_LENGTH = 16;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;
// frames arrive about once a second
const SILENCE_TIMEOUT_MS = 15000;

// two magic words, eight zero bytes, username and access code each zero padded to 32
export const authPacket = (accessCode: string, username = "bblp"): Buffer => {
  const packet = Buffer.alloc(80);
  packet.writeUInt32LE(0x40, 0);
  packet.writeUInt32LE(0x3000, 4);
  packet.write(username, 16, 32, "ascii");
  packet.write(accessCode, 48, 32, "ascii");
  return packet;
};

// 16 byte header whose first word is the little endian jpeg length, then the jpeg
export class FrameParser {
  private pending: Buffer = Buffer.alloc(0);
  private expected = 0;

  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      if (!this.expected) {
        if (this.pending.length < HEADER_LENGTH) break;
        this.expected = this.pending.readUInt32LE(0);
        this.pending = this.pending.subarray(HEADER_LENGTH);
        if (this.expected < 4)
          throw new Error(`frame header claims ${this.expected} bytes, stream is out of sync`);
      }
      if (this.pending.length < this.expected) break;
      const frame = this.pending.subarray(0, this.expected);
      this.pending = this.pending.subarray(this.expected);
      this.expected = 0;
      if (frame.readUInt16BE(0) !== 0xffd8 || frame.readUInt16BE(frame.length - 2) !== 0xffd9)
        throw new Error("frame is not a jpeg, stream is out of sync");
      frames.push(frame);
    }
    return frames;
  }
}

export class ChamberClient extends EventEmitter<{ frame: [Buffer] }> {
  latest?: Buffer;
  latestAt = 0;
  private readonly host: string;
  private readonly accessCode: string;
  private readonly console: Console;
  private socket?: TLSSocket;
  private wanted = false;
  private retryDelay = RETRY_MIN_MS;
  private retryTimer?: NodeJS.Timeout;

  constructor(host: string, accessCode: string, console: Console) {
    super();
    this.host = host;
    this.accessCode = accessCode;
    this.console = console;
  }

  get connected() {
    return !!this.socket;
  }

  start() {
    this.wanted = true;
    if (!this.socket && !this.retryTimer) this.connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }

  private connect() {
    const parser = new FrameParser();
    let gotFrame = false;
    // self signed certificate on the printer
    const socket = connect({ host: this.host, port: CHAMBER_PORT, rejectUnauthorized: false });
    this.socket = socket;
    socket.setTimeout(SILENCE_TIMEOUT_MS);
    socket.on("secureConnect", () => socket.write(authPacket(this.accessCode)));
    socket.on("data", (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = parser.push(chunk);
      } catch (e) {
        this.console.error("chamber camera:", (e as Error).message);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        gotFrame = true;
        this.retryDelay = RETRY_MIN_MS;
        this.latest = frame;
        this.latestAt = Date.now();
        this.emit("frame", frame);
      }
    });
    socket.on("timeout", () => {
      if (!gotFrame)
        this.console.error(
          "printer accepted the camera connection but sent nothing, it is probably already serving its maximum of two camera clients (bambu studio, home assistant, ...)"
        );
      socket.destroy(new Error(`no frames for ${SILENCE_TIMEOUT_MS / 1000}s`));
    });
    socket.on("error", (e) => this.console.error("chamber camera:", e.message));
    socket.on("close", () => {
      // a newer socket may already have replaced this one
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.wanted) return;
      if (!gotFrame)
        this.console.error(
          "printer closed the camera connection without sending a frame, check the access code and that the printer is in lan mode"
        );
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (this.wanted) this.connect();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    });
  }
}
