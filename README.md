# GTD Inbox

Capture thoughts by sending text or voice messages (Slovak or English) to a Telegram bot.
Gemini (via Vertex AI) turns each one into a structured GTD item stored in Cloudflare D1.
A web dashboard (Phase 2) is for reviewing and managing items.

Architecture, data model and conventions are in [CLAUDE.md](CLAUDE.md).

## Requirements

- Node.js 22+
- A Cloudflare account (Workers + D1)
- A Google Cloud project with billing/credits and the Vertex AI API enabled
- Telegram

## Setup

### 1. Install

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in as you go; never commit it
```

### 2. Telegram bot

1. In Telegram, talk to **@BotFather** → `/newbot` → pick a name and username.
   Copy the token → `TELEGRAM_BOT_TOKEN`.
2. Generate a webhook secret → `TELEGRAM_WEBHOOK_SECRET`:
   ```sh
   openssl rand -hex 32
   ```
3. Find your chat id → `ALLOWED_CHAT_ID`: send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.
   (Do this **before** registering the webhook — `getUpdates` stops working once a webhook is set.)

### 3. Cloudflare D1

```sh
npx wrangler login
npx wrangler d1 create gtd
```

Copy the printed `database_id` into `wrangler.jsonc` (`d1_databases[0].database_id`) and commit it
(the id is not a secret). Then create the tables:

```sh
npx wrangler d1 migrations apply DB --remote   # production
npm run db:migrate:local                       # local dev database
```

### 4. Google Cloud / Vertex AI

```sh
gcloud config set project YOUR_PROJECT_ID
gcloud services enable aiplatform.googleapis.com

gcloud iam service-accounts create gtd-bot --display-name "GTD bot"
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member "serviceAccount:gtd-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role "roles/aiplatform.user"
gcloud iam service-accounts keys create gtd-key.json \
  --iam-account gtd-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

- `GCP_PROJECT_ID` = `YOUR_PROJECT_ID`
- `GCP_SERVICE_ACCOUNT_JSON` = the contents of `gtd-key.json` on one line:
  `jq -c . gtd-key.json`. Delete the file once the secret is stored.
- `GCP_LOCATION` (default `global`) and `GEMINI_MODEL` (default `gemini-3.8-flash`) are plain vars in
  `wrangler.jsonc`. Check the current Flash model id in the
  [Vertex AI model list](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions)
  and update `GEMINI_MODEL` when Google retires it. New models are often available on `global` only.
- `TIMEZONE` (default `Europe/Bratislava`) is used to resolve "by Friday"-style deadlines.

### 5. Production secrets

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ALLOWED_CHAT_ID
npx wrangler secret put GCP_PROJECT_ID
jq -c . gtd-key.json | npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON
```

(`wrangler secret put` needs the Worker to exist; if it doesn't yet, run `npm run deploy` once first.)

### 6. Deploy

**Workers Builds (recommended):** Cloudflare dashboard → Workers & Pages → Create → Import a
repository → pick this repo. Settings:

| Setting         | Value                                                              |
| --------------- | ------------------------------------------------------------------ |
| Build command   | *(empty)*                                                          |
| Deploy command  | `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy` |
| Production branch | `main`                                                           |

Every push to `main` applies new migrations, then deploys.

**Manual:** `npm run deploy` (same two steps).

### 7. Register the webhook

```sh
npm run set-webhook -- https://gtd-inbox.<your-subdomain>.workers.dev
npm run set-webhook -- --info      # check status / last error
```

The script reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` from the environment or
`.dev.vars`. Make sure the secret matches the one in step 5. It also registers the `/` command menu.

Equivalent curl:

```sh
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://gtd-inbox.<sub>.workers.dev/telegram/webhook\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
```

### 8. Cloudflare Access (before Phase 2 ships)

Zero Trust → Access → Applications → Add a self-hosted application:

- Application domain: your Worker host, **path empty** (whole site) → policy: allow your email.
- Add a second application for the same host with path `telegram/webhook` and a **Bypass**
  policy for Everyone, so Telegram can reach the webhook. The webhook is protected by the secret
  token header and the chat-id allow-list instead.

## Local development

```sh
npm run dev          # wrangler dev on http://localhost:8787
npm test             # vitest, runs inside the Workers runtime
npm run typecheck
```

To talk to your local bot from Telegram, expose it with a tunnel
(`npx cloudflared tunnel --url http://localhost:8787`) and run
`npm run set-webhook -- https://<tunnel-host>`. Re-register the production URL afterwards.

## Using the bot

- Send any text or voice note → the bot replies e.g. `📌 Email the professor · 10 min · @pc · next`
  with buttons **Done / Someday / Delete / Is project**.
- `/inbox` — items you haven't reviewed yet (tapping any button marks an item reviewed)
- `/quick` — next actions that take ≤15 min
- `/help`

If the AI step fails, the note is still saved, as an inbox item flagged ⚠️ for review.
