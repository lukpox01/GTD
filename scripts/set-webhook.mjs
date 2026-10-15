#!/usr/bin/env node
// Register (or inspect) the Telegram webhook.
//
//   npm run set-webhook -- https://gtd-inbox.<you>.workers.dev
//   npm run set-webhook -- --info
//
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from the environment,
// falling back to .dev.vars. Use the SAME secret you stored with `wrangler secret put`.
import { readFileSync } from "node:fs";

function loadDevVars() {
  try {
    const vars = {};
    for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) vars[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    return vars;
  } catch {
    return {};
  }
}

const devVars = loadDevVars();
const token = process.env.TELEGRAM_BOT_TOKEN ?? devVars.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? devVars.TELEGRAM_WEBHOOK_SECRET;
const arg = process.argv[2];

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set (env or .dev.vars)");
  process.exit(1);
}

async function call(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

if (!arg || arg === "--info") {
  console.log(JSON.stringify(await call("getWebhookInfo"), null, 2));
  if (!arg) console.log("\nUsage: npm run set-webhook -- https://<your-worker-host>");
  process.exit(0);
}

if (!secret) {
  console.error("TELEGRAM_WEBHOOK_SECRET is not set (env or .dev.vars)");
  process.exit(1);
}

const base = arg.replace(/\/+$/, "");
const url = base.endsWith("/telegram/webhook") ? base : `${base}/telegram/webhook`;
const result = await call("setWebhook", {
  url,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: false,
});
console.log(JSON.stringify(result, null, 2));

const commands = await call("setMyCommands", {
  commands: [
    { command: "inbox", description: "Items you haven't reviewed yet" },
    { command: "quick", description: "Next actions that take ≤15 min" },
    { command: "help", description: "Show help" },
  ],
});
console.log("setMyCommands:", commands.ok ? "ok" : commands);
process.exit(result.ok ? 0 : 1);
