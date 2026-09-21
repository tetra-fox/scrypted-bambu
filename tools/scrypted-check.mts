import { connectScryptedClient } from "@scrypted/client";
import type { Camera, DeviceCreator, ScryptedDevice, Settings, VideoCamera } from "@scrypted/sdk";

const [scryptedHost, printerHost, accessCode] = process.argv.slice(2);
const { SCRYPTED_USERNAME: username, SCRYPTED_PASSWORD: password } = process.env;
if (!scryptedHost || !printerHost || !accessCode || !username || !password) {
  console.error(
    "usage: SCRYPTED_USERNAME=.. SCRYPTED_PASSWORD=.. node tools/scrypted-check.mts <scrypted host> <printer ip> <access code>"
  );
  process.exit(2);
}

const sdk = await connectScryptedClient({
  baseUrl: `https://${scryptedHost}:10443`,
  pluginId: "@scrypted/core",
  username,
  password
});

const provider = sdk.systemManager.getDeviceByName<DeviceCreator>("Bambu Lab");
if (!provider) throw new Error("the Bambu Lab plugin is not installed on this server");

const id = await provider.createDevice({
  name: "scrypted-bambu check",
  host: printerHost,
  accessCode,
  camera: "auto"
});
const printer = sdk.systemManager.getDeviceById<ScryptedDevice & Camera & VideoCamera & Settings>(
  id
);
console.log("created", id, "interfaces", printer.interfaces.join(", "));
const settings = await printer.getSettings();
console.log("camera setting:", settings.find((s) => s.key === "camera")?.value);

try {
  const started = Date.now();
  const snapshot = await sdk.mediaManager.convertMediaObjectToBuffer(
    await printer.takePicture(),
    "image/jpeg"
  );
  console.log(
    `snapshot: ${snapshot.length} bytes in ${Date.now() - started}ms, jpeg=${snapshot.readUInt16BE(0) === 0xffd8}`
  );

  const [vso] = await printer.getVideoStreamOptions();
  const stream = await printer.getVideoStream(vso);
  const input = await sdk.mediaManager.convertMediaObjectToJSON<{
    url?: string;
    inputArguments?: string[];
    mediaStreamOptions?: { video?: { codec?: string } };
  }>(stream, "x-scrypted/x-ffmpeg-input");
  console.log("stream url:", input.url);
  console.log("stream codec as advertised:", input.mediaStreamOptions?.video?.codec);

  // a decoded frame proves the transcoded stream plays
  const frameStarted = Date.now();
  const frame = await sdk.mediaManager.convertMediaObjectToBuffer(
    await printer.getVideoStream(vso),
    "image/jpeg"
  );
  console.log(`frame from stream: ${frame.length} bytes in ${Date.now() - frameStarted}ms`);
  await sdk.systemManager.removeDevice(id);
  console.log("removed", id);
} catch (e) {
  console.error(`failed, leaving device ${id} in place for inspection:`, e);
  process.exitCode = 1;
} finally {
  sdk.disconnect();
}
