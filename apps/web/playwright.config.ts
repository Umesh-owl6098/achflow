import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../scripts",
  testMatch: "capture-working-demo.ts",
  timeout: 30_000,
  use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } },
});
