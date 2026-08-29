import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "../../test/security/windows-paths/**/*.test.ts"],
  },
});
