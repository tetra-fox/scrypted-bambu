import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";

const BOUNDARY = "frame";

export class FrameFeed {
  private readonly server: Server;
  private readonly clients = new Set<ServerResponse>();
  private readonly onClientCount: (count: number) => void;
  private readonly paceMs: number;
  private readonly staleMs: number;
  private latest?: Buffer;
  private latestAt = 0;
  private pacer?: NodeJS.Timeout;

  // resends the newest frame every paceMs while anyone is reading, until it is staleMs old.
  // a source that went quiet then stalls readers instead of freezing them
  constructor(onClientCount: (count: number) => void, paceMs: number, staleMs: number) {
    this.onClientCount = onClientCount;
    this.paceMs = paceMs;
    this.staleMs = staleMs;
    this.server = createServer((_, response) => {
      response.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "Cache-Control": "no-cache",
        "Connection": "close"
      });
      this.clients.add(response);
      response.on("close", () => {
        this.clients.delete(response);
        if (!this.clients.size) this.stopPacing();
        this.onClientCount(this.clients.size);
      });
      // lets ffmpeg probe without waiting for the next frame
      if (this.latest) this.write(response, this.latest);
      this.startPacing();
      this.onClientCount(this.clients.size);
    });
  }

  async listen(): Promise<number> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("frame feed did not get a tcp port");
    return address.port;
  }

  push(frame: Buffer) {
    this.latest = frame;
    this.latestAt = Date.now();
  }

  // the printer sends a frame every second or two. ffmpeg only writes the -r duplicates for
  // a gap once the next frame arrives, so forwarding frames as they come gives live players
  // a burst of frames followed by silence. a steady input keeps the output steady
  private startPacing() {
    if (this.pacer) return;
    this.pacer = setInterval(() => {
      if (this.latest && Date.now() - this.latestAt < this.staleMs) this.broadcast(this.latest);
    }, this.paceMs);
  }

  private stopPacing() {
    clearInterval(this.pacer);
    this.pacer = undefined;
  }

  private broadcast(frame: Buffer) {
    for (const client of this.clients) {
      // a stalled reader misses frames rather than buffering them
      if (!client.writableNeedDrain) this.write(client, frame);
    }
  }

  private write(response: ServerResponse, frame: Buffer) {
    response.write(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
    );
    response.write(frame);
    response.write("\r\n");
  }

  close() {
    this.stopPacing();
    for (const client of this.clients) client.destroy();
    this.server.close();
  }
}
