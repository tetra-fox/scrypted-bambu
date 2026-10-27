import { once } from "node:events";
import { connect } from "node:net";

import sdk, {
  type AudioStreamOptions,
  type Camera,
  type DeviceInformation,
  type DeviceProvider,
  type FFmpegInput,
  type MediaObject,
  type MediaStreamUrl,
  type OnOff,
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
import { identifyPrinter, type PrinterIdentity } from "./identify.ts";
import {
  chamberInputArguments,
  DEFAULT_ENCODER_ARGUMENTS,
  FRAME_PACING_MS,
  splitArguments,
  STALE_FRAME_MS
} from "./pipeline.ts";
import { chamberLightModes, ledctrl, type Report, ReportClient } from "./report.ts";

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

const CHAMBER_MODELS = new Set(["P1P", "P1S", "A1", "A1 mini"]);
const RTSP_MODELS = new Set(["X1", "X1C", "X1E", "H2C", "H2D", "H2D Pro", "H2S", "P2S", "X2D"]);

export const cameraForModel = (model: string | undefined): CameraKind | undefined => {
  if (model && CHAMBER_MODELS.has(model)) return "chamber";
  if (model && RTSP_MODELS.has(model)) return "rtsp";
  return undefined;
};

export const infoFor = (host: string, identity: PrinterIdentity): DeviceInformation => ({
  manufacturer: "Bambu Lab",
  model: identity.model,
  serialNumber: identity.serial,
  firmware: identity.firmware,
  version: identity.hardware,
  ip: host,
  metadata: { nozzleDiameter: identity.nozzleDiameter, nozzleType: identity.nozzleType }
});

export const interfacesFor = (camera: CameraKind): ScryptedInterface[] => {
  // the provider of the chamber light
  const interfaces = [
    ScryptedInterface.VideoCamera,
    ScryptedInterface.Settings,
    ScryptedInterface.DeviceProvider
  ];
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
    this.feed = new FrameFeed(
      (count) => {
        this.feedClients = count;
        this.scheduleIdle();
      },
      FRAME_PACING_MS,
      STALE_FRAME_MS
    );
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

// a child device so the homekit plugin adds it to the camera accessory as a switch. onoff on the
// camera itself would drive the camera's status indicator instead
class ChamberLight extends ScryptedDeviceBase implements OnOff {
  private readonly printer: BambuPrinter;

  constructor(nativeId: string, printer: BambuPrinter) {
    super(nativeId);
    this.printer = printer;
  }

  async turnOn() {
    this.printer.setChamberLight(true);
    this.on = true;
  }

  async turnOff() {
    this.printer.setChamberLight(false);
    this.on = false;
  }
}

export class BambuPrinter
  extends ScryptedDeviceBase
  implements VideoCamera, Camera, Settings, DeviceProvider
{
  storageSettings = new StorageSettings(this, {
    host: {
      title: "IP Address",
      placeholder: "192.168.1.50",
      onPut: () => this.reconnect()
    },
    accessCode: {
      title: "Access Code",
      type: "password",
      description: "On the printer screen under Settings, Network.",
      onPut: () => this.reconnect()
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
      onPut: () => this.releaseCamera()
    }
  });

  // the native id is the serial, see createDevice
  private readonly serial: string;
  private source?: CameraSource;
  private report?: ReportClient;
  private light?: ChamberLight;
  // last reported mode of each chamber light node
  private readonly lightModes: Record<string, string> = {};

  constructor(nativeId: string) {
    super(nativeId);
    this.serial = nativeId;
    this.storageSettings.options = {
      hide: {
        encoderArguments: async () => this.storageSettings.values.camera !== "chamber"
      }
    };
    this.startReports();
    // a printer registered without the light device gets it on start
    if (!this.interfaces?.includes(ScryptedInterface.DeviceProvider))
      this.register(undefined).catch((e: Error) => this.console.error("register:", e.message));
  }

  private getSource(): CameraSource {
    this.source ??=
      this.storageSettings.values.camera === "rtsp"
        ? new RtspSource(this)
        : new ChamberSource(this);
    return this.source;
  }

  private releaseCamera() {
    this.source?.release();
    this.source = undefined;
  }

  release() {
    this.releaseCamera();
    this.report?.stop();
    this.report = undefined;
  }

  // undefined while createDevice is storing host and access code one at a time
  private credentials() {
    const { host, accessCode } = this.storageSettings.values;
    return host && accessCode ? { host, accessCode } : undefined;
  }

  private startReports() {
    this.report?.stop();
    this.report = undefined;
    const credentials = this.credentials();
    if (!credentials) return;
    this.report = new ReportClient(
      credentials.host,
      credentials.accessCode,
      this.serial,
      this.console
    );
    this.report.on("report", (report) => this.onReport(report));
    this.report.start();
  }

  private onReport(report: Report) {
    const modes = chamberLightModes(report);
    if (!modes) return;
    Object.assign(this.lightModes, modes);
    const on = this.chamberLightOn();
    if (this.light && this.light.on !== on) this.light.on = on;
  }

  private chamberLightOn() {
    return Object.values(this.lightModes).includes("on");
  }

  setChamberLight(on: boolean) {
    if (!this.report) throw new Error("set the ip address and access code first");
    // ha-bambulab switches a second chamber light together with the first. before the first
    // report the printer's nodes are unknown, every model has chamber_light
    const nodes = Object.keys(this.lightModes);
    for (const node of nodes.length ? nodes : ["chamber_light"]) {
      this.report.request(ledctrl(node, on));
      this.lightModes[node] = on ? "on" : "off";
    }
  }

  private async register(info: DeviceInformation | undefined) {
    await deviceManager.onDeviceDiscovered({
      nativeId: this.nativeId,
      name: this.name!,
      type: ScryptedDeviceType.Camera,
      interfaces: interfacesFor(this.storageSettings.values.camera),
      info
    });
    await deviceManager.onDeviceDiscovered({
      nativeId: `${this.serial}-light`,
      providerNativeId: this.nativeId,
      name: `${this.name} Chamber Light`,
      type: ScryptedDeviceType.Light,
      interfaces: [ScryptedInterface.OnOff]
    });
  }

  async getDevice(nativeId: string): Promise<ChamberLight> {
    this.light ??= new ChamberLight(nativeId, this);
    // reports can arrive before scrypted asks for the light
    if (Object.keys(this.lightModes).length) this.light.on = this.chamberLightOn();
    return this.light;
  }

  async releaseDevice(): Promise<void> {
    this.light = undefined;
  }

  private async applyCamera() {
    this.releaseCamera();
    await this.register(this.info);
  }

  private reconnect() {
    this.releaseCamera();
    this.startReports();
    if (!this.credentials()) return;
    this.refreshInfo().catch((e: Error) => this.console.error("printer info:", e.message));
  }

  async refreshInfo() {
    const { host, accessCode } = this.storageSettings.values;
    await this.register(infoFor(host, await identifyPrinter(host, accessCode)));
  }

  async getSettings(): Promise<Setting[]> {
    return [
      ...(await this.storageSettings.getSettings()),
      {
        key: "refresh",
        title: "Refresh Printer Info",
        description: "Read the model, firmware and nozzle from the printer again.",
        type: "button"
      }
    ];
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    if (key === "refresh") return this.refreshInfo();
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
