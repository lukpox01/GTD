export interface Env {
  DB: D1Database;

  // secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
  GCP_SERVICE_ACCOUNT_JSON: string;
  GCP_PROJECT_ID: string;

  // vars (wrangler.jsonc)
  GCP_LOCATION: string;
  GEMINI_MODEL: string;
  TIMEZONE: string;
}
