import { randomBytes } from "node:crypto";

import sdk, {
  type DeviceCreator,
  type DeviceCreatorSettings,
  type DeviceProvider,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  type Setting
} from "@scrypted/sdk";

import { BambuPrinter, type CameraKind, detectCamera, interfacesFor } from "./printer.ts";

const { deviceManager } = sdk;

class BambuProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
  private readonly printers = new Map<string, BambuPrinter>();

  constructor(nativeId?: string) {
    super(nativeId);
    this.systemDevice = {
      deviceCreator: "Bambu Lab Printer"
    };
  }

  async getCreateDeviceSettings(): Promise<Setting[]> {
    return [
      {
        key: "name",
        title: "Name",
        placeholder: "P1S"
      },
      {
        key: "host",
        title: "IP Address",
        placeholder: "192.168.1.50",
        description: "The printer must be reachable from Scrypted. LAN Only mode is fine."
      },
      {
        key: "accessCode",
        title: "Access Code",
        type: "password",
        description: "On the printer screen under Settings, Network."
      },
      {
        key: "camera",
        title: "Camera",
        choices: ["auto", "chamber", "rtsp"],
        value: "auto",
        description:
          "auto asks the printer: rtsp when port 322 answers (X1, H2, P2), otherwise the chamber image protocol (P1, A1)."
      }
    ];
  }

  async createDevice(settings: DeviceCreatorSettings): Promise<string> {
    const host = String(settings.host ?? "").trim();
    const accessCode = String(settings.accessCode ?? "").trim();
    if (!host || !accessCode) throw new Error("ip address and access code are required");
    const requested = String(settings.camera ?? "auto");
    const camera: CameraKind =
      requested === "auto" ? await detectCamera(host) : (requested as CameraKind);

    const nativeId = randomBytes(4).toString("hex");
    const id = await deviceManager.onDeviceDiscovered({
      nativeId,
      name: String(settings.name || "").trim() || "Bambu Printer",
      type: ScryptedDeviceType.Camera,
      interfaces: interfacesFor(camera),
      info: {
        manufacturer: "Bambu Lab",
        ip: host
      }
    });
    const printer = await this.getDevice(nativeId);
    printer.storageSettings.values.host = host;
    printer.storageSettings.values.accessCode = accessCode;
    printer.storageSettings.values.camera = camera;
    return id;
  }

  async getDevice(nativeId: string): Promise<BambuPrinter> {
    let printer = this.printers.get(nativeId);
    if (!printer) {
      printer = new BambuPrinter(nativeId);
      this.printers.set(nativeId, printer);
    }
    return printer;
  }

  async releaseDevice(id: string, nativeId: string): Promise<void> {
    this.printers.get(nativeId)?.release();
    this.printers.delete(nativeId);
  }
}

export default BambuProvider;
