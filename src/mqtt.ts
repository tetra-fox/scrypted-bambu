import { EventEmitter } from "node:events";
import { connect, type TLSSocket } from "node:tls";

export const MQTT_PORT = 8883;
const KEEPALIVE_S = 30;

const CONNECT = 0x10;
const CONNACK = 0x20;
const PUBLISH = 0x30;
const SUBSCRIBE = 0x82;
const DISCONNECT = 0xe0;
const CONNECT_FLAGS_USER_PASS_CLEAN = 0xc2;

const CONNACK_ERRORS: Record<number, string> = {
  1: "unacceptable protocol version",
  2: "identifier rejected",
  3: "server unavailable",
  4: "bad username or password",
  5: "not authorized"
};

const lengthPrefixed = (s: string): Buffer => {
  const bytes = Buffer.from(s);
  return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes]);
};

// mqtt remaining length: 7 bits per byte, high bit means another byte follows
export const encodeRemainingLength = (n: number): Buffer => {
  const out: number[] = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n) digit |= 0x80;
    out.push(digit);
  } while (n);
  return Buffer.from(out);
};

const packet = (type: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([type]), encodeRemainingLength(body.length), body]);

export interface Packet {
  type: number;
  body: Buffer;
}

export class PacketParser {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Packet[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const packets: Packet[] = [];
    for (;;) {
      let length = 0;
      let multiplier = 1;
      let offset = 1;
      let byte: number;
      do {
        if (offset >= this.pending.length) return packets;
        byte = this.pending[offset++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
      } while (byte & 0x80);
      if (this.pending.length < offset + length) return packets;
      packets.push({
        type: this.pending[0] >> 4,
        body: this.pending.subarray(offset, offset + length)
      });
      this.pending = this.pending.subarray(offset + length);
    }
  }
}

export interface Message {
  topic: string;
  payload: Buffer;
}

export const parsePublish = (body: Buffer): Message => {
  const topicLength = body.readUInt16BE(0);
  return {
    topic: body.subarray(2, 2 + topicLength).toString(),
    payload: body.subarray(2 + topicLength)
  };
};

export class MqttClient extends EventEmitter<{ message: [Message]; error: [Error]; close: [] }> {
  private readonly socket: TLSSocket;
  private readonly parser = new PacketParser();
  private packetId = 1;

  private constructor(socket: TLSSocket) {
    super();
    this.socket = socket;
  }

  // the printer's broker takes username bblp and the lan access code, over a self signed certificate
  static connect(host: string, accessCode: string): Promise<MqttClient> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port: MQTT_PORT, rejectUnauthorized: false });
      const client = new MqttClient(socket);
      socket.once("error", reject);
      socket.on("secureConnect", () => {
        const header = Buffer.concat([
          lengthPrefixed("MQTT"),
          Buffer.from([4, CONNECT_FLAGS_USER_PASS_CLEAN, 0, KEEPALIVE_S])
        ]);
        const payload = Buffer.concat([
          lengthPrefixed(`scrypted-${process.pid}-${Date.now()}`),
          lengthPrefixed("bblp"),
          lengthPrefixed(accessCode)
        ]);
        socket.write(packet(CONNECT, Buffer.concat([header, payload])));
      });
      socket.on("data", (chunk: Buffer) => {
        for (const { type, body } of client.parser.push(chunk)) {
          if (type === CONNACK >> 4) {
            const code = body[1];
            if (code === 0) {
              socket.off("error", reject);
              socket.on("error", (e) => client.emit("error", e));
              resolve(client);
            } else {
              socket.destroy();
              reject(
                new Error(
                  `printer refused the mqtt login: ${CONNACK_ERRORS[code] ?? `code ${code}`}`
                )
              );
            }
          } else if (type === PUBLISH >> 4) {
            client.emit("message", parsePublish(body));
          }
        }
      });
      socket.on("close", () => client.emit("close"));
    });
  }

  subscribe(topic: string) {
    const id = this.packetId++;
    this.socket.write(
      packet(
        SUBSCRIBE,
        Buffer.concat([Buffer.from([id >> 8, id & 0xff]), lengthPrefixed(topic), Buffer.from([0])])
      )
    );
  }

  publish(topic: string, payload: string) {
    this.socket.write(
      packet(PUBLISH, Buffer.concat([lengthPrefixed(topic), Buffer.from(payload)]))
    );
  }

  end() {
    this.socket.write(packet(DISCONNECT, Buffer.alloc(0)));
    this.socket.end();
  }
}
