import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const useSystemChrome = !process.env.CI && (existsSync("/usr/bin/google-chrome") || existsSync("/usr/bin/google-chrome-stable"));

export default defineConfig({
  testDir: "./tests/ui",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry"
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(useSystemChrome ? { channel: "chrome" } : {}) }
    }
  ]
});
