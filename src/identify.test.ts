import assert from "node:assert/strict";
import { test } from "node:test";

import { modelFromModules } from "./identify.ts";

test("p1p on 2023 firmware, no product name", () => {
  assert.equal(
    modelFromModules([
      { name: "ota", project_name: "C11", sw_ver: "01.06.01.00", hw_ver: "OTA" },
      { name: "esp32", project_name: "C11", sw_ver: "01.08.27.60", hw_ver: "AP04" },
      { name: "mc", project_name: "P1", hw_ver: "MC07" }
    ]),
    "P1P"
  );
});

test("p1s on newer firmware reports a product name on the ota module", () => {
  assert.equal(
    modelFromModules([
      { name: "ota", sw_ver: "01.08.00.00", hw_ver: "OTA", product_name: "Bambu Lab P1S" },
      { name: "esp32", sw_ver: "01.11.35.43", hw_ver: "AP04", product_name: "" }
    ]),
    "P1S"
  );
});

test("legacy board table", () => {
  assert.equal(modelFromModules([{ hw_ver: "AP04", project_name: "C12" }]), "P1S");
  assert.equal(modelFromModules([{ hw_ver: "AP05", project_name: "N2S" }]), "A1");
  assert.equal(modelFromModules([{ hw_ver: "AP07", project_name: "N1" }]), "A1 mini");
  assert.equal(modelFromModules([{ hw_ver: "AP05", name: "rv1126" }]), "X1C");
  assert.equal(modelFromModules([{ hw_ver: "AP02", name: "ap" }]), "X1E");
});

test("unknown boards give no model rather than a wrong one", () => {
  assert.equal(modelFromModules([{ hw_ver: "AP09", project_name: "Z9" }]), undefined);
  assert.equal(modelFromModules([]), undefined);
});
