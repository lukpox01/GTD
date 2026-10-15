import { Hono } from "hono";
import { createDeps, type Deps } from "./deps";
import type { Env } from "./env";
import { handleUpdate, isAllowedChat, verifySecretToken } from "./telegram/webhook";
import type { TgUpdate } from "./telegram/types";

export function createApp(makeDeps: (env: Env) => Deps = createDeps) {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/telegram/webhook", async (c) => {
    if (!verifySecretToken(c.req.header("X-Telegram-Bot-Api-Secret-Token"), c.env.TELEGRAM_WEBHOOK_SECRET)) {
      return c.text("unauthorized", 401);
    }

    let update: TgUpdate;
    try {
      update = await c.req.json<TgUpdate>();
    } catch {
      return c.text("bad request", 400);
    }
    if (typeof update?.update_id !== "number") return c.text("bad request", 400);

    // Strangers get a 200 too, so Telegram doesn't keep retrying — we just drop the update.
    if (!isAllowedChat(update, c.env.ALLOWED_CHAT_ID)) return c.text("ok");

    const deps = makeDeps(c.env);
    c.executionCtx.waitUntil(
      handleUpdate(deps, update).catch((e: unknown) => {
        console.error("update failed", update.update_id, e instanceof Error ? e.stack : e);
      }),
    );
    return c.text("ok");
  });

  // Dashboard API (Phase 2). Protected by Cloudflare Access.
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.notFound((c) => c.text("not found", 404));
  return app;
}

export default createApp() satisfies ExportedHandler<Env>;
