import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["shared/src/**/*.test.ts", "server/src/**/*.test.ts", "web/src/**/*.test.ts"],
    // localRunner tests spawn real processes; keep them serial.
    fileParallelism: false,
    // ...and real processes are slow to start on a cold machine. A first
    // python spawn into a fresh temp directory blew past vitest's 5s default
    // on a CI runner, where Defender scans the new directory before anything
    // executes. These are integration tests: give them room rather than
    // pretending process startup is instant.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
