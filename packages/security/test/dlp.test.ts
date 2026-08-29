import { expect, test } from "vitest";
import { intendedPatchDependsOnRedacted, scanSourceContent, scanText, stableRedactionMarker } from "../src/dlp.js";

test("permitted redaction uses a stable marker for the same literal", () => {
  const email = "release-bot@example.invalid";
  const first = scanText({ text: `contact ${email}` });
  const second = scanText({ text: `contact ${email}` });
  expect(first.redactedText).toBe(second.redactedText);
  expect(first.redactedText.includes(email)).toBe(false);
  expect(first.findings[0]?.marker).toBe(stableRedactionMarker("email", email));
  expect(first.findings[0]?.redactionPermitted).toBe(true);
});

test("intended-patch-depends-on-redacted-bytes is detected", () => {
  const scanned = scanText({ text: "contact release-bot@example.invalid", path: "src/parse.ts" });
  expect(
    intendedPatchDependsOnRedacted({
      findings: scanned.findings,
      intendedPatchPaths: ["src/parse.ts"],
    }),
  ).toBe(true);
});

test("base64-encoded AWS access key is classified restricted", () => {
  const awsKey = "AKIA0000000000000001";
  const scanned = scanSourceContent({
    content: { encoding: "base64", base64: Buffer.from(`const key = "${awsKey}";`, "utf8").toString("base64") },
  });
  expect(scanned.classification).toBe("restricted");
  expect(scanned.findings.some((finding) => finding.findingType === "aws-access-key")).toBe(true);
});

test("invalid base64 fails closed as restricted", () => {
  const scanned = scanSourceContent({
    content: { encoding: "base64", base64: "@@@@" },
  });
  expect(scanned.classification).toBe("restricted");
  expect(scanned.inspectable).toBe(false);
});
