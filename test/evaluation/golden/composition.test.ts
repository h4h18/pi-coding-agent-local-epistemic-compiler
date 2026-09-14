import { expect, test } from "vitest";
import { compositionForGoldenTask, primaryIntentForGoldenKind } from "./composition.js";
import { TASK_KINDS } from "./types.js";

test("golden kinds map onto composition rather than monolithic profiles", () => {
  expect(primaryIntentForGoldenKind("security")).toBe("security-remediation");
  expect(primaryIntentForGoldenKind("migration")).toBe("migration");
  expect(primaryIntentForGoldenKind("performance")).toBe("optimization");
  expect(primaryIntentForGoldenKind("ui")).toBe("feature");
  const security = compositionForGoldenTask("security", "node-backend");
  expect(security.primaryIntent).toBe("security-remediation");
  expect(security.overlays).toContain("security-sensitive");
  expect(security.verificationPacks).toContain("security");
  const migration = compositionForGoldenTask("migration", "migration-public-api");
  expect(migration.overlays).toEqual(expect.arrayContaining(["migration", "public-api"]));
  const ui = compositionForGoldenTask("ui", "react-spa");
  expect(ui.overlays).toContain("ui-visible");
  expect(ui.verificationPacks).toContain("web-ui");
  for (const kind of TASK_KINDS) {
    expect(compositionForGoldenTask(kind, "node-backend").schemaVersion).toBe(2);
  }
});
