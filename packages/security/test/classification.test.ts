import { expect, test } from "vitest";
import {
  classifyContent,
  classifyPathName,
  luhnValid,
  maxClassification,
  scanSensitiveSpans,
} from "../src/classification.js";

test("restricted classes cannot be overridden by a public project policy", () => {
  const result = classifyContent({
    path: "src/app.ts",
    text: `const key = "AKIA0000000000000001";`,
    projectClassification: "public",
  });
  expect(result.classification).toBe("restricted");
});

test("id_rsa paths are restricted", () => {
  expect(classifyPathName(".ssh/id_rsa")).toBe("restricted");
});

test("luhn rejects short digit strings and accepts a visa test PAN", () => {
  expect(luhnValid("4111111111111111")).toBe(true);
  expect(luhnValid("123")).toBe(false);
});

test("maxClassification is monotonic", () => {
  expect(maxClassification(["public", "internal", "confidential"])).toBe("confidential");
  expect(maxClassification(["restricted", "public"])).toBe("restricted");
});

test("pem private keys are restricted signing material", () => {
  const pem = `-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----`;
  const spans = scanSensitiveSpans(pem);
  expect(spans.some((span) => span.classification === "restricted")).toBe(true);
});
