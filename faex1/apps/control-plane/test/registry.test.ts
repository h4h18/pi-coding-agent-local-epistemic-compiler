import { afterAll, beforeAll, expect, test } from "vitest";
import { HTTP_OPERATIONS } from "@pi-hec/contracts";
import { startHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

test("registered Fastify routes equal HTTP_OPERATIONS path and method", () => {
  const registered = [
    ...(harness?.listening.mtls.registryRoutes ?? []),
    ...(harness?.listening.enroll.registryRoutes ?? []),
  ].map((route) => `${route.method} ${route.path}`);
  const expected = HTTP_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`);
  expect([...registered].sort()).toEqual([...expected].sort());
  expect(registered).toHaveLength(HTTP_OPERATIONS.length);
});
