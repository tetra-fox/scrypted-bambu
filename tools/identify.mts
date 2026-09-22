import { identifyPrinter } from "../src/identify.ts";

const [host, accessCode] = process.argv.slice(2);
if (!host || !accessCode) {
  console.error("usage: node tools/identify.mts <host> <access code>");
  process.exit(2);
}
console.log(JSON.stringify(await identifyPrinter(host, accessCode), null, 2));
