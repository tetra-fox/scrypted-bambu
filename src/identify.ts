import { connect } from "node:tls";

import { MQTT_PORT, MqttClient } from "./mqtt.ts";

export interface PrinterIdentity {
  serial: string;
  model?: string;
  firmware?: string;
  hardware?: string;
  nozzleDiameter?: string;
  nozzleType?: string;
}

export interface VersionModule {
  name?: string;
  project_name?: string;
  product_name?: string;
  sw_ver?: string;
  hw_ver?: string;
  sn?: string;
}

const REPORT_GRACE_MS = 3000;
const TIMEOUT_MS = 10000;

// the printer's certificate is issued to its serial number
export const readSerial = (host: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port: MQTT_PORT, rejectUnauthorized: false });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const { CN } = socket.getPeerCertificate().subject ?? {};
      const serial = typeof CN === "string" ? CN : CN?.[0];
      socket.end();
      if (serial) resolve(serial);
      else reject(new Error("printer certificate has no serial number"));
    });
  });

// firmware from 2024 on reports a product name. older firmware is told apart by the
// ap board revision and project code, which bambu reused across models later on
export const modelFromModules = (modules: VersionModule[]): string | undefined => {
  const named = modules.find((m) => m.product_name?.startsWith("Bambu Lab "));
  if (named) return named.product_name!.slice("Bambu Lab ".length);
  const ap = modules.find((m) => m.hw_ver?.startsWith("AP"));
  if (!ap) return undefined;
  if (ap.hw_ver === "AP02") return "X1E";
  if (ap.project_name === "N1") return "A1 mini";
  if (ap.hw_ver === "AP04" && ap.project_name === "C11") return "P1P";
  if (ap.hw_ver === "AP04" && ap.project_name === "C12") return "P1S";
  if (ap.hw_ver === "AP05" && ap.project_name === "N2S") return "A1";
  if (ap.hw_ver === "AP05" && !ap.project_name) return "X1C";
  return undefined;
};

export const identifyPrinter = async (
  host: string,
  accessCode: string
): Promise<PrinterIdentity> => {
  const serial = await readSerial(host);
  const client = await MqttClient.connect(host, accessCode);
  try {
    const identity: PrinterIdentity = { serial };
    let gotVersion: () => void;
    let gotReport: () => void;
    const version = new Promise<void>((resolve) => (gotVersion = resolve));
    const report = new Promise<void>((resolve) => (gotReport = resolve));
    const failed = new Promise<never>((_, reject) => {
      client.once("error", reject);
      client.once("close", () => reject(new Error("printer closed the mqtt connection")));
      setTimeout(
        () => reject(new Error("printer did not answer the version request")),
        TIMEOUT_MS
      ).unref();
    });
    client.on("message", ({ payload }) => {
      const message = JSON.parse(payload.toString());
      if (message.info?.command === "get_version") {
        const modules: VersionModule[] = message.info.module ?? [];
        identity.model = modelFromModules(modules);
        identity.firmware = modules.find((m) => m.name === "ota")?.sw_ver;
        identity.hardware = modules.find((m) => m.hw_ver?.startsWith("AP"))?.hw_ver;
        gotVersion();
      }
      if (message.print?.nozzle_diameter !== undefined) {
        identity.nozzleDiameter = message.print.nozzle_diameter;
        identity.nozzleType = message.print.nozzle_type;
        gotReport();
      }
    });
    client.subscribe(`device/${serial}/report`);
    client.publish(
      `device/${serial}/request`,
      JSON.stringify({ info: { sequence_id: "0", command: "get_version" } })
    );
    client.publish(
      `device/${serial}/request`,
      JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } })
    );
    await Promise.race([version, failed]);
    // the full report is a bonus, not every firmware answers pushall
    await Promise.race([report, new Promise((r) => setTimeout(r, REPORT_GRACE_MS).unref())]);
    return identity;
  } finally {
    client.end();
  }
};
