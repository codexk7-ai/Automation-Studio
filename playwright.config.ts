import { defineConfig, devices } from "@playwright/test";

const PORT = 8899;
/** Set E2E_BASE_URL (e.g. https://localhost) to test a running deployment instead. */
const EXTERNAL = process.env.E2E_BASE_URL;

/**
 * Browser end-to-end tests against the production build with a throwaway
 * in-memory database. Run `npm run build` first (CI does).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: EXTERNAL ?? `http://127.0.0.1:${PORT}`,
    ignoreHTTPSErrors: !!EXTERNAL, // Caddy's internal CA for localhost
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: EXTERNAL
    ? undefined
    : {
        command: "node dist/main.js",
        cwd: "apps/server",
        url: `http://127.0.0.1:${PORT}/api/ready`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          NODE_ENV: "test",
          PORT: String(PORT),
          HOST: "127.0.0.1",
          PUBLIC_URL: `http://127.0.0.1:${PORT}`,
          PGLITE_DATA_DIR: "memory://",
          DATABASE_URL: "",
          ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          LOG_LEVEL: "warn",
          AUTH_RATE_LIMIT_PER_MINUTE: "100",
          WORKER_POLL_MS: "200",
        },
      },
});
