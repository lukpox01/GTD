import type { Env } from "./env";
import { GeminiVertexProvider } from "./llm/gemini-vertex";
import type { LlmProvider } from "./llm/types";
import { parseServiceAccount } from "./llm/vertex-auth";
import { TelegramClient, type TelegramApi } from "./telegram/api";

/** Everything the bot logic needs. Built from Env in production, faked in tests. */
export interface Deps {
  db: D1Database;
  telegram: TelegramApi;
  /** Lazy so a misconfigured LLM secret doesn't break commands and buttons. */
  llm: () => LlmProvider;
}

export function createDeps(env: Env): Deps {
  let provider: LlmProvider | undefined;
  return {
    db: env.DB,
    telegram: new TelegramClient(env.TELEGRAM_BOT_TOKEN),
    llm: () =>
      (provider ??= new GeminiVertexProvider({
        serviceAccount: parseServiceAccount(env.GCP_SERVICE_ACCOUNT_JSON),
        projectId: env.GCP_PROJECT_ID,
        location: env.GCP_LOCATION,
        model: env.GEMINI_MODEL,
        timezone: env.TIMEZONE,
      })),
  };
}
