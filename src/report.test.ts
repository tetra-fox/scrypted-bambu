import assert from "node:assert/strict";
import { test } from "node:test";

import { chamberLightModes } from "./report.ts";

test("a report without a light list leaves the modes unknown", () => {
  assert.equal(chamberLightModes({}), undefined);
  assert.equal(chamberLightModes({ print: {} }), undefined);
});

test("both chamber lights are picked up and other lights are not", () => {
  const modes = chamberLightModes({
    print: {
      lights_report: [
        { node: "chamber_light", mode: "off" },
        { node: "chamber_light2", mode: "on" },
        { node: "work_light", mode: "flashing" }
      ]
    }
  });
  assert.deepEqual(modes, { chamber_light: "off", chamber_light2: "on" });
});
