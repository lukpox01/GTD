import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only bindings; real secrets never live in the repo.
          bindings: {
            TEST_MIGRATIONS: migrations,
            TELEGRAM_BOT_TOKEN: "test-token",
            TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
            ALLOWED_CHAT_ID: "4242",
            GCP_SERVICE_ACCOUNT_JSON: "{}",
            GCP_PROJECT_ID: "test-project",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
