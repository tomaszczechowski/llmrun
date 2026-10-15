import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        exclude: ["**/node_modules/**", "**/dist/**", "**/.kilo/**"],
        // Tests that touch the ledger point LLMRUN_HOME at a temp dir.
        testTimeout: 15_000,
    },
});
