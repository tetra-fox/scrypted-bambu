import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";

const BOUNDARY = "frame";

export class FrameFeed {
  private readonly server: Server;
  private readonly clients = new Set<ServerResponse>();
  private readonly onClientCount: (count: number) => void;
  private latest?: Buffer;

  constructor(onClientCount: (count: number) => void) {
    this.onClientCount = onClientCount;
    this.server = createServer((_, response) => {
      response.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "Cache-Control": "no-cache",
        "Connection": "close"
      });
      this.clients.add(response);
      response.on("close", () => {
        this.clients.delete(response);
        this.onClientCount(this.clients.size);
      });
      // lets ffmpeg probe without waiting for the next frame
      if (this.latest) this.write(response, this.latest);
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
    for (const client of this.clients) client.destroy();
    this.server.close();
  }
}
