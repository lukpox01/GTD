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
  /** Gemini 3 thinking level (e.g. "low"; gemini-3.8-flash rejects "minimal"); empty = model default. */
  GEMINI_THINKING_LEVEL: string;
  TIMEZONE: string;
  /** Cloudflare Access team, e.g. "myteam" or "myteam.cloudflareaccess.com". Empty = /api refuses all requests. */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the dashboard's Access application. */
  ACCESS_AUD: string;
}
