import sdk, {
  type DeviceCreator,
  type DeviceCreatorSettings,
  type DeviceProvider,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  type Setting
} from "@scrypted/sdk";

import { identifyPrinter } from "./identify.ts";
import {
  BambuPrinter,
  type CameraKind,
  cameraForModel,
  detectCamera,
  infoFor,
  interfacesFor
} from "./printer.ts";

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
        description: "Defaults to the model the printer reports, e.g. Bambu Lab P1S."
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
          "auto picks by model: chamber image protocol for P1 and A1, rtsp for X1, H2 and P2. Unknown models are probed on port 322."
      }
    ];
  }

  async createDevice(settings: DeviceCreatorSettings): Promise<string> {
    const host = String(settings.host ?? "").trim();
    const accessCode = String(settings.accessCode ?? "").trim();
    if (!host || !accessCode) throw new Error("ip address and access code are required");
    const identity = await identifyPrinter(host, accessCode);
    const requested = String(settings.camera ?? "auto");
    const camera: CameraKind =
      requested === "auto"
        ? (cameraForModel(identity.model) ?? (await detectCamera(host)))
        : (requested as CameraKind);

    // the serial as native id makes adding the same printer twice update it instead
    const nativeId = identity.serial;
    const id = await deviceManager.onDeviceDiscovered({
      nativeId,
      name: String(settings.name || "").trim() || `Bambu Lab ${identity.model ?? "Printer"}`,
      type: ScryptedDeviceType.Camera,
      interfaces: interfacesFor(camera),
      info: infoFor(host, identity)
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
