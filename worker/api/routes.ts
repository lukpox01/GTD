import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  appendLog,
  countItems,
  getItem,
  insertItem,
  ITEM_STATUSES,
  ITEM_TYPES,
  ITEM_VIEWS,
  LEVELS,
  listContexts,
  listItems,
  updateItem,
} from "../db/items";
import { createProject, getProject, listProjects, PROJECT_STATUSES, updateProject } from "../db/projects";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { classifyInto, type ClassifySource } from "../pipeline/process";
import { AccessError, accessToken, fetchAccessKeys, verifyAccessJwt, type AccessIdentity } from "./access";

type ApiEnv = { Bindings: Env; Variables: { deps: Deps; identity: AccessIdentity } };
type Ctx = Context<ApiEnv>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const optionalText = z
  .string()
  .trim()
  .max(4000)
  .nullable()
  .transform((s) => (s === "" ? null : s));

const itemPatchSchema = z
  .object({
    title: optionalText,
    next_action: optionalText,
    notes: optionalText,
    type: z.enum(ITEM_TYPES).nullable(),
    status: z.enum(ITEM_STATUSES),
    project_id: z.number().int().positive().nullable(),
    context: optionalText,
    time_estimate_min: z.number().int().min(0).max(100_000).nullable(),
    energy: z.enum(LEVELS).nullable(),
    priority: z.enum(LEVELS).nullable(),
    due_date: z.iso.date().nullable(),
    reviewed: z.boolean(),
  })
  .partial()
  .strict();

const newItemSchema = z.object({ text: z.string().trim().min(1).max(4000), classify: z.boolean().default(true) });

const newProjectSchema = z.object({ name: z.string().trim().min(1).max(200), outcome: optionalText.optional() });

const projectPatchSchema = z
  .object({ name: z.string().trim().min(1).max(200), outcome: optionalText, status: z.enum(PROJECT_STATUSES) })
  .partial()
  .strict();

async function body<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T> | Response> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
  return parsed.data;
}

function idParam(c: Ctx): number | null {
  const id = Number(c.req.param("id"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The dashboard JSON API, mounted at /api. Every route requires a valid Cloudflare Access JWT. */
export function apiRoutes(makeDeps: (env: Env) => Deps) {
  const api = new Hono<ApiEnv>();

  api.use("*", async (c, next) => {
    // Browsers send this; refusing cross-site requests stops CSRF via the Access cookie.
    const site = c.req.header("Sec-Fetch-Site");
    if (site && site !== "same-origin" && site !== "none") return c.json({ error: "cross-site request" }, 403);

    const deps = makeDeps(c.env);
    c.set("deps", deps);

    const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
    if (!team?.trim() || !aud?.trim()) {
      // Unconfigured: fail closed, except for `wrangler dev` on this machine.
      if (LOCAL_HOSTS.has(new URL(c.req.url).hostname)) {
        c.set("identity", { email: "local-dev", sub: "local-dev" });
        return next();
      }
      return c.json({ error: "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)" }, 503);
    }

    const token = accessToken(c.req.header("Cf-Access-Jwt-Assertion"), c.req.header("Cookie"));
    if (!token) return c.json({ error: "unauthorized" }, 401);
    try {
      c.set(
        "identity",
        await verifyAccessJwt(token, {
          teamDomain: team,
          audience: aud.trim(),
          fetchKeys: deps.accessKeys ?? fetchAccessKeys,
        }),
      );
    } catch (e) {
      if (e instanceof AccessError) return c.json({ error: "unauthorized" }, 401);
      throw e;
    }
    return next();
  });

  api.get("/health", (c) => c.json({ ok: true }));
  api.get("/me", (c) => c.json(c.get("identity")));

  api.get("/items", async (c) => {
    const view = c.req.query("view") ?? "inbox";
    if (!(ITEM_VIEWS as readonly string[]).includes(view)) return c.json({ error: `unknown view "${view}"` }, 400);
    const project = c.req.query("project_id");
    const limit = c.req.query("limit");
    const items = await listItems(c.get("deps").db, {
      view: view as (typeof ITEM_VIEWS)[number],
      ...(project ? { projectId: Number(project) } : {}),
      ...(c.req.query("context") ? { context: c.req.query("context") } : {}),
      ...(c.req.query("q")?.trim() ? { q: c.req.query("q")?.trim() } : {}),
      ...(limit ? { limit: Number(limit) || 200 } : {}),
    });
    return c.json({ items });
  });

  api.get("/counts", async (c) => c.json(await countItems(c.get("deps").db)));
  api.get("/contexts", async (c) => c.json({ contexts: await listContexts(c.get("deps").db) }));

  /** Capture from the dashboard. Classified synchronously, like a Telegram note but without a bot reply. */
  api.post("/items", async (c) => {
    const input = await body(c, newItemSchema);
    if (input instanceof Response) return input;
    const deps = c.get("deps");
    const log = [{ step: "received", at: new Date().toISOString(), detail: "dashboard" }];
    const id = await insertItem(deps.db, {
      source: "text",
      raw_text: input.text,
      telegram_chat_id: null,
      telegram_message_id: null,
      telegram_file_id: null,
      pipeline_log: log,
    });
    if (input.classify) await classifyInto(deps, id, { kind: "text", text: input.text }, log);
    return c.json({ item: await getItem(deps.db, id) }, 201);
  });

  api.get("/items/:id", async (c) => {
    const id = idParam(c);
    const item = id ? await getItem(c.get("deps").db, id) : null;
    return item ? c.json({ item }) : c.json({ error: "not found" }, 404);
  });

  api.patch("/items/:id", async (c) => {
    const id = idParam(c);
    if (!id) return c.json({ error: "not found" }, 404);
    const patch = await body(c, itemPatchSchema);
    if (patch instanceof Response) return patch;
    const db = c.get("deps").db;
    if (patch.project_id != null && !(await getProject(db, patch.project_id))) {
      return c.json({ error: `project ${patch.project_id} not found` }, 400);
    }
    if (!(await updateItem(db, id, patch))) return c.json({ error: "not found" }, 404);
    return c.json({ item: await getItem(db, id) });
  });

  /** Soft delete; restore by PATCHing a status. */
  api.delete("/items/:id", async (c) => {
    const id = idParam(c);
    const db = c.get("deps").db;
    if (!id || !(await updateItem(db, id, { status: "deleted" }))) return c.json({ error: "not found" }, 404);
    return c.json({ item: await getItem(db, id) });
  });

  /** Re-run the AI on the original note (text, or the voice file still on Telegram). Overwrites AI fields. */
  api.post("/items/:id/reclassify", async (c) => {
    const id = idParam(c);
    const deps = c.get("deps");
    const item = id ? await getItem(deps.db, id) : null;
    if (!id || !item) return c.json({ error: "not found" }, 404);

    let source: ClassifySource;
    if (item.source === "voice" && item.telegram_file_id) {
      source = { kind: "voice", fileId: item.telegram_file_id, mimeType: "audio/ogg" };
    } else if (item.raw_text) {
      source = { kind: "text", text: item.raw_text };
    } else {
      return c.json({ error: "nothing to classify: the original note is missing" }, 409);
    }
    const log = await appendLog(deps.db, id, { step: "reclassify", at: new Date().toISOString(), detail: "dashboard" });
    await classifyInto(deps, id, source, log);
    return c.json({ item: await getItem(deps.db, id) });
  });

  api.get("/projects", async (c) => c.json({ projects: await listProjects(c.get("deps").db) }));

  api.post("/projects", async (c) => {
    const input = await body(c, newProjectSchema);
    if (input instanceof Response) return input;
    const db = c.get("deps").db;
    const id = await createProject(db, { name: input.name, outcome: input.outcome ?? null });
    return c.json({ project: await getProject(db, id) }, 201);
  });

  api.patch("/projects/:id", async (c) => {
    const id = idParam(c);
    if (!id) return c.json({ error: "not found" }, 404);
    const patch = await body(c, projectPatchSchema);
    if (patch instanceof Response) return patch;
    const db = c.get("deps").db;
    if (!(await updateProject(db, id, patch))) return c.json({ error: "not found" }, 404);
    return c.json({ project: await getProject(db, id) });
  });

  api.all("*", (c) => c.json({ error: "not found" }, 404));
  return api;
}
