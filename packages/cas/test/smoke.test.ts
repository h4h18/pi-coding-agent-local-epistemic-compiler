import { expect, test } from "vitest";
import { packageName } from "../src/index.js";

test("exports the package name", () => {
  expect(packageName).toBe("@pi-hec/cas");
});
