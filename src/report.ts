import { EventEmitter } from "node:events";

import { MqttClient } from "./mqtt.ts";

const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;

export const reportTopic = (serial: string) => `device/${serial}/report`;
export const requestTopic = (serial: string) => `device/${serial}/request`;

export const PUSHALL = { pushing: { sequence_id: "0", command: "pushall" } };

// the payload ha-bambulab sends, the timing fields are for the flashing mode
export const ledctrl = (node: string, on: boolean) => ({
  system: {
    sequence_id: "0",
    command: "ledctrl",
    led_node: node,
    led_mode: on ? "on" : "off",
    led_on_time: 500,
    led_off_time: 500,
    loop_times: 0,
    interval_time: 0
  }
});

export interface Report {
  print?: { lights_report?: { node?: string; mode?: string }[] };
}

// h2 and x2 printers report chamber_light2 next to chamber_light. undefined when the report
// carries no light list
export const chamberLightModes = (report: Report): Record<string, string> | undefined => {
  const lights = report.print?.lights_report;
  if (!lights) return undefined;
  const modes: Record<string, string> = {};
  for (const { node, mode } of lights) {
    if (node?.startsWith("chamber_light") && mode) modes[node] = mode;
  }
  return modes;
};

// keeps an mqtt session to the printer open for its reports and for sending commands
export class ReportClient extends EventEmitter<{ report: [Report] }> {
  private readonly host: string;
  private readonly accessCode: string;
  private readonly serial: string;
  private readonly console: Console;
  private client?: MqttClient;
  private stopped = false;
  private failing = false;
  private retryDelay = RETRY_MIN_MS;
  private retryTimer?: NodeJS.Timeout;

  constructor(host: string, accessCode: string, serial: string, console: Console) {
    super();
    this.host = host;
    this.accessCode = accessCode;
    this.serial = serial;
    this.console = console;
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.client?.end();
    this.client = undefined;
  }

  request(command: object) {
    if (!this.client) throw new Error("not connected to the printer's mqtt broker");
    this.client.publish(requestTopic(this.serial), JSON.stringify(command));
  }

  private connect() {
    MqttClient.connect(this.host, this.accessCode).then(
      (client) => this.attach(client),
      (e: Error) => {
        // a printer that is switched off would log every retry otherwise
        if (!this.failing) this.console.error("printer mqtt:", e.message, "(retrying quietly)");
        this.failing = true;
        this.retry();
      }
    );
  }

  private attach(client: MqttClient) {
    if (this.stopped) {
      client.end();
      return;
    }
    if (this.failing) this.console.log("printer mqtt connected again");
    this.failing = false;
    this.client = client;
    this.retryDelay = RETRY_MIN_MS;
    client.on("error", (e) => this.console.error("printer mqtt:", e.message));
    client.on("close", () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.retry();
    });
    client.on("message", ({ payload }) => {
      let report: Report;
      try {
        report = JSON.parse(payload.toString());
      } catch (e) {
        this.console.error("printer mqtt: report is not json:", (e as Error).message);
        return;
      }
      this.emit("report", report);
    });
    client.subscribe(reportTopic(this.serial));
    // p1 and a1 printers send partial reports, this asks for the full state once
    this.request(PUSHALL);
  }

  private retry() {
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }
}
