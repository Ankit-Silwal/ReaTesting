import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  timeout: 30000,
  fullyParallel: true,
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1440, height: 940 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm.cmd run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
  },
});
