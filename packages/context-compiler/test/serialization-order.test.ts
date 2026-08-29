import { expect, test } from "vitest";
import { SERIALIZATION_SECTION_TITLES, compileCloudContext } from "../src/index.js";
import { compilerInput } from "./fixtures.js";

test("golden serialization order matches §19.3", () => {
  const outcome = compileCloudContext(compilerInput());
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  const user = outcome.artifacts.conversation.messages[0];
  expect(user?.role).toBe("user");
  const text = user?.content[0];
  expect(text?.kind).toBe("text");
  if (text?.kind !== "text") {
    return;
  }
  let cursor = 0;
  for (const title of SERIALIZATION_SECTION_TITLES) {
    const index = text.text.indexOf(`## ${title}`);
    expect(index).toBeGreaterThanOrEqual(cursor);
    cursor = index;
  }
});
