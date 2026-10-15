# CLAUDE.md

Personal GTD system: Telegram bot captures notes (text/voice, Slovak/English) → Gemini on Vertex AI
classifies them → Cloudflare D1. A web dashboard reviews and manages items. Setup steps for the owner are in README.md.

## Architecture

One Cloudflare Worker (TypeScript, Hono) serves:

| Route                    | What                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `POST /telegram/webhook` | Telegram bot. Public, but verified (secret header + chat allow-list) |
| `/api/*`                 | Dashboard JSON API. Behind Cloudflare Access, JWT re-verified here   |
| everything else          | Dashboard SPA from Workers static assets (`dashboard/dist`, Vite build) |

`wrangler.jsonc` has `run_worker_first: ["/api/*", "/telegram/*"]`; other paths never reach the Worker.

### Webhook flow

1. `worker/index.ts` checks `X-Telegram-Bot-Api-Secret-Token` (constant-time), parses the update,
   drops updates from any chat ≠ `ALLOWED_CHAT_ID` (still 200, so Telegram stops retrying),
   then returns 200 at once and runs `handleUpdate` in `ctx.waitUntil()`.
2. `telegram/webhook.ts` `handleUpdate`: dedupes on `update_id` (`telegram_updates` table), then
   routes: callback_query → `callbacks.ts`; `/command` → `commands/`; text/voice → pipeline.
3. `pipeline/process.ts`: **inserts the raw note first**, then (voice: download via getFile) →
   `llm().classify()` → save fields → reply with summary + inline keyboard. Any failure → row stays
   `status='inbox'`, `needs_review=1`, error + raw LLM output in `pipeline_log`. Notes are never lost.

`waitUntil` work is capped at ~30 s after the response. If long voice notes start timing out,
move processing to Cloudflare Queues (the raw row is already saved, so nothing is lost meanwhile).

### Dashboard API (`worker/api/`)

- `routes.ts` — Hono sub-app mounted at `/api`. A middleware runs first on every route:
  refuses `Sec-Fetch-Site: cross-site` (CSRF via the Access cookie), then verifies the Access JWT
  (`Cf-Access-Jwt-Assertion` header, `CF_Authorization` cookie as fallback). If `ACCESS_TEAM_DOMAIN`
  or `ACCESS_AUD` is empty the API answers 503 (fail closed), except on `localhost` for `wrangler dev`.
- `access.ts` — RS256 verification with WebCrypto against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
  (keys cached per isolate, refetched hourly or on an unknown `kid`), checks `iss`, `aud`, `exp`, `nbf`.
- Routes: `GET /items?view=&project_id=&context=&q=`, `GET /counts`, `GET /contexts`, `GET /me`,
  `POST /items {text, classify?}` (capture + classify synchronously, no bot reply),
  `GET|PATCH|DELETE /items/:id`, `POST /items/:id/reclassify`, `GET|POST /projects`, `PATCH /projects/:id`.
  Bodies are validated with zod (`.strict()`, unknown fields → 400).
- Views: `inbox` = the review queue (`reviewed_at IS NULL`, not done/deleted, same as the bot's `/inbox`);
  `next|waiting|scheduled|someday|done|deleted` = that status; `all` = everything but deleted.
- `PATCH` with a `status` marks the item reviewed (like a bot button); `reviewed: true|false` approves
  or sends it back to the inbox. `DELETE` is the soft delete; restore = `PATCH {status}`.
- Reclassify re-runs `pipeline/process.ts` `classifyInto` (shared with the bot) on `raw_text`, or
  re-downloads the voice file by `telegram_file_id`. It overwrites the AI fields.
- Dashboard edits don't update the bot's Telegram message for that item.

### Dashboard (`dashboard/`)

Svelte 5 (runes) + Vite, no router or UI library. `npm run build` → `dashboard/dist`.
`src/lib/api.ts` is the typed client; it imports the row types from `worker/db/*` (type-only), so
API and UI share one definition. Hash routes: `#/inbox`, `#/next`, …, `#/projects`, `#/project/:id`.
`src/App.svelte` owns state; `components/ItemCard` (row) → `ItemEditor` (inline edit form).
`npm run typecheck` also runs `svelte-check` on it.

### LLM layer (`worker/llm/`)

- `types.ts` — `LlmProvider.classify({ text?, audio? }) → { item: ClassifiedItem, model }`;
  providers throw `ClassificationError` with `rawOutput` / `partialTranscript` when possible.
- `schema.ts` — zod `classifiedItemSchema` (source of truth) + Vertex `responseSchema`
  (kept in sync by a test) + `parseClassification` (never throws). Optional fields that are
  invalid become `null` instead of failing the whole note; `title` and `type` are required.
- `prompt.ts` — system prompt + user prompt with today's date in `TIMEZONE`.
- `gemini-vertex.ts` — `generateContent` with `responseMimeType: application/json` + `responseSchema`,
  `thinkingConfig.thinkingLevel` from `GEMINI_THINKING_LEVEL` (default `low`; `minimal` is rejected by gemini-3.8-flash).
  Voice is sent as `inlineData` (`audio/ogg`); transcription + classification is ONE call.
  Endpoint host is `aiplatform.googleapis.com` for `GCP_LOCATION=global`, else `{loc}-aiplatform…`.
- `vertex-auth.ts` — service-account RS256 JWT via WebCrypto → OAuth token, cached per isolate
  until 5 min before expiry, concurrent refreshes share one request. No Node libraries.

Adding `ClaudeProvider` (Phase 4): implement `LlmProvider`; for audio, run a separate transcription
step first and set `item.transcript`; select the provider in `worker/deps.ts`.

### Dependency injection

`worker/deps.ts` builds `Deps { db, telegram: TelegramApi, llm: () => LlmProvider }` from `Env`.
`createApp(makeDeps)` lets tests inject fakes (`test/helpers.ts`: `FakeTelegram`, `FakeProvider`).
`llm` is lazy so a broken GCP secret only affects classification, not commands/buttons.

## Data model (`migrations/`)

- `items` — capture (`source`, `raw_text`, `transcript`, telegram ids incl. `telegram_file_id` for
  re-processing voice, `bot_message_id`), GTD fields (`title`, `next_action`, `notes`, `type`,
  `status`, `project_id`, `context`, `time_estimate_min`, `energy`, `steps_count`, `due_date`),
  `priority` (**user only**) vs `suggested_priority` (AI), AI metadata (`ai_confidence`, `ai_model`,
  `language`), `needs_review` (AI failed), `reviewed_at` (NULL = unreviewed; set by any bot button
  or dashboard approval), `pipeline_log` (JSON array of `{step, at, detail?, error?}`).
- `projects` — `name`, `outcome`, `status` (active/someday/done/dropped).
- `telegram_updates` — processed `update_id`s.

Items captured in the dashboard have `source='text'` and no Telegram ids.

Enums are enforced with CHECK constraints. Timestamps are ISO-8601 UTC strings. Dates are `YYYY-MM-DD`.
Priority values: `high` | `medium` | `low`.

Rules: the AI never sets `priority`, `done` or `deleted`, and must not invent `due_date`.
Delete is a soft delete (`status='deleted'`).

## Bot

- Reply: `formatItemMessage` in `telegram/format.ts`, always rendered from the DB row, so a button
  tap just updates the row and re-renders. Labels are English; item text stays in the note's language.
- Buttons: `callback_data = "<action>:<itemId>"`, actions `done | someday | delete | project`.
  "Is project" creates a project named after the item (idempotent) and links it.
- Commands: one file per command in `telegram/commands/`, exporting a `Command`; add it to
  `COMMANDS` in `commands/index.ts`. `/help` is generated from the registry. Also update the
  `setMyCommands` list in `scripts/set-webhook.mjs`.

## Config

Secrets (`wrangler secret put` / `.dev.vars`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`ALLOWED_CHAT_ID`, `GCP_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`.
Vars (`wrangler.jsonc`): `GCP_LOCATION`, `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`, `TIMEZONE`,
`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (Cloudflare Access app for the dashboard; not secrets). Types live in `worker/env.ts`.
Never commit secrets; `.dev.vars` is gitignored.

## Commands

```sh
npm test               # vitest in the Workers runtime (@cloudflare/vitest-plugin), D1 migrated in test/setup.ts
npm run typecheck      # tsc --noEmit, strict + svelte-check for the dashboard
npm run build          # dashboard → dashboard/dist
npm run dev            # build + local worker on :8787 (API open on localhost)
npm run dev:dashboard  # Vite with hot reload on :5173, proxies /api to `npm run dev`
npm run deploy         # build + migrations apply --remote + wrangler deploy
npm run set-webhook -- <url> | --info
```

Note: `npm install` with npm 10 hits an arborist bug on vitest's peer deps; use `npx npm@11 install <pkg>`
to add/update packages. `npm ci` (what CI uses) works fine with the committed lockfile.

## Conventions

- TypeScript strict (+ `noUncheckedIndexedAccess`), small modules, minimal dependencies (hono, zod; svelte + vite for the dashboard).
- Every behaviour change comes with a test. Tests use fakes, never real Telegram/Vertex.
- New schema change = new numbered file in `migrations/`; never edit an applied migration.
- `main` must always deploy: run `npm run typecheck && npm test` before pushing.
- Keep this file updated when architecture or conventions change.

## Phases

1. ✅ Skeleton, schema, webhook, Gemini via Vertex (text + voice), D1, bot replies/buttons/commands, tests.
2. ✅ Dashboard (Svelte + Vite → static assets) + `/api` (verify Cloudflare Access JWT in the Worker too).
3. Weekly review, deadline reminders (Cron Triggers), search.
4. Optional `ClaudeProvider` + provider comparison script.
