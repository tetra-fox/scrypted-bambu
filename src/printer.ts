import { once } from "node:events";
import { connect } from "node:net";

import sdk, {
  type AudioStreamOptions,
  type Camera,
  type FFmpegInput,
  type MediaObject,
  type MediaStreamUrl,
  type ResponseMediaStreamOptions,
  type ResponsePictureOptions,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedMimeTypes,
  type Setting,
  type Settings,
  type SettingValue,
  type VideoCamera
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";

import { ChamberClient } from "./chamber.ts";
import { FrameFeed } from "./feed.ts";
import { chamberInputArguments, DEFAULT_ENCODER_ARGUMENTS, splitArguments } from "./pipeline.ts";

const { deviceManager, mediaManager } = sdk;

export type CameraKind = "chamber" | "rtsp";

export const RTSP_PORT = 322;
const PROBE_TIMEOUT_MS = 2000;
const SNAPSHOT_FRESH_MS = 3000;
const SNAPSHOT_TIMEOUT_MS = 10000;
// after the last stream or snapshot
const IDLE_MS = 60000;

// the sdk types audio as optional, rebroadcast only reads an explicit null as no audio
const NO_AUDIO = null as unknown as AudioStreamOptions;

export const interfacesFor = (camera: CameraKind): ScryptedInterface[] => {
  const interfaces = [ScryptedInterface.VideoCamera, ScryptedInterface.Settings];
  // only the chamber protocol yields jpegs, rtsp snapshots come from the prebuffer
  if (camera === "chamber") interfaces.push(ScryptedInterface.Camera);
  return interfaces;
};

// x1, h2 and p2 answer on the rtsps port, p1 and a1 do not
export const detectCamera = (host: string): Promise<CameraKind> => {
  return new Promise((resolve) => {
    let kind: CameraKind = "chamber";
    const socket = connect({ host, port: RTSP_PORT });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      kind = "rtsp";
      socket.destroy();
    });
    socket.once("timeout", () => socket.destroy());
    // refused is the expected answer from p1 and a1, close still fires
    socket.once("error", () => {});
    socket.once("close", () => resolve(kind));
  });
};

interface CameraSource {
  getVideoStreamOptions(): ResponseMediaStreamOptions[];
  getVideoStream(): Promise<MediaObject>;
  takePicture?(): Promise<Buffer>;
  release(): void;
}

class ChamberSource implements CameraSource {
  private readonly printer: BambuPrinter;
  private readonly client: ChamberClient;
  private readonly feed: FrameFeed;
  private port?: Promise<number>;
  private feedClients = 0;
  private idleTimer?: NodeJS.Timeout;

  constructor(printer: BambuPrinter) {
    this.printer = printer;
    const { host, accessCode } = printer.storageSettings.values;
    this.client = new ChamberClient(host, accessCode, printer.console);
    this.feed = new FrameFeed((count) => {
      this.feedClients = count;
      this.scheduleIdle();
    });
    this.client.on("frame", (frame) => this.feed.push(frame));
  }

  getVideoStreamOptions(): ResponseMediaStreamOptions[] {
    return [
      {
        id: "chamber",
        name: "Chamber",
        container: "mjpeg",
        tool: "ffmpeg",
        source: "local",
        // after the rebroadcast transcode
        video: { codec: "h264" },
        audio: NO_AUDIO
      }
    ];
  }

  async getVideoStream(): Promise<MediaObject> {
    this.port ??= this.feed.listen();
    const url = `http://127.0.0.1:${await this.port}/`;
    this.client.start();
    const input: FFmpegInput = {
      url,
      inputArguments: chamberInputArguments(url),
      // marked rebroadcast only in the sdk, rebroadcast is the consumer
      h264EncoderArguments: splitArguments(this.printer.storageSettings.values.encoderArguments),
      mediaStreamOptions: this.getVideoStreamOptions()[0]
    };
    return mediaManager.createFFmpegMediaObject(input, { sourceId: this.printer.id });
  }

  async takePicture(): Promise<Buffer> {
    this.scheduleIdle();
    if (this.client.latest && Date.now() - this.client.latestAt < SNAPSHOT_FRESH_MS)
      return this.client.latest;
    this.client.start();
    const [frame] = await once(this.client, "frame", {
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)
    });
    return frame;
  }

  private scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.feedClients) this.client.stop();
    }, IDLE_MS);
  }

  release() {
    clearTimeout(this.idleTimer);
    this.client.stop();
    this.feed.close();
  }
}

class RtspSource implements CameraSource {
  private readonly printer: BambuPrinter;

  constructor(printer: BambuPrinter) {
    this.printer = printer;
  }

  getVideoStreamOptions(): ResponseMediaStreamOptions[] {
    return [
      {
        id: "rtsp",
        name: "Chamber",
        container: "rtsp",
        source: "local",
        video: { codec: "h264" },
        audio: NO_AUDIO
      }
    ];
  }

  async getVideoStream(): Promise<MediaObject> {
    const { host, accessCode } = this.printer.storageSettings.values;
    const vso = this.getVideoStreamOptions()[0];
    const ret: MediaStreamUrl = {
      url: `rtsps://bblp:${encodeURIComponent(accessCode)}@${host}:${RTSP_PORT}/streaming/live/1`,
      container: vso.container,
      mediaStreamOptions: vso
    };
    return this.printer.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
  }

  release() {}
}

export class BambuPrinter extends ScryptedDeviceBase implements VideoCamera, Camera, Settings {
  storageSettings = new StorageSettings(this, {
    host: {
      title: "IP Address",
      placeholder: "192.168.1.50",
      onPut: () => this.release()
    },
    accessCode: {
      title: "Access Code",
      type: "password",
      description: "On the printer screen under Settings, Network.",
      onPut: () => this.release()
    },
    camera: {
      title: "Camera",
      choices: ["chamber", "rtsp"],
      defaultValue: "chamber",
      description:
        "chamber: P1 and A1 series push JPEG frames on port 6000 and this plugin transcodes them. rtsp: X1, H2 and P2 series serve H.264 over RTSPS on port 322.",
      onPut: () => this.applyCamera()
    },
    encoderArguments: {
      title: "H.264 Encoder Arguments",
      description:
        "FFmpeg output arguments the Rebroadcast plugin uses to turn chamber JPEG frames into H.264. Keep the setpts filter, it gives the frames their timing. Add further filters after it in the same -vf chain.",
      combobox: true,
      choices: [DEFAULT_ENCODER_ARGUMENTS],
      defaultValue: DEFAULT_ENCODER_ARGUMENTS,
      onPut: () => this.release()
    }
  });

  private source?: CameraSource;

  constructor(nativeId: string) {
    super(nativeId);
    this.storageSettings.options = {
      hide: {
        encoderArguments: async () => this.storageSettings.values.camera !== "chamber"
      }
    };
  }

  private getSource(): CameraSource {
    this.source ??=
      this.storageSettings.values.camera === "rtsp"
        ? new RtspSource(this)
        : new ChamberSource(this);
    return this.source;
  }

  release() {
    this.source?.release();
    this.source = undefined;
  }

  private async applyCamera() {
    this.release();
    await deviceManager.onDeviceDiscovered({
      nativeId: this.nativeId,
      name: this.name!,
      type: ScryptedDeviceType.Camera,
      interfaces: interfacesFor(this.storageSettings.values.camera),
      info: this.info
    });
  }

  getSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
    return this.getSource().getVideoStreamOptions();
  }

  async getVideoStream(): Promise<MediaObject> {
    return this.getSource().getVideoStream();
  }

  async takePicture(): Promise<MediaObject> {
    const source = this.getSource();
    if (!source.takePicture)
      throw new Error("this printer streams rtsp, snapshots come from the rebroadcast prebuffer");
    return this.createMediaObject(await source.takePicture(), "image/jpeg");
  }

  async getPictureOptions(): Promise<ResponsePictureOptions[]> {
    return [];
  }
}
