import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache, type AccessJwk } from "../worker/api/access";
import { getItem, insertItem, updateItem, type Item } from "../worker/db/items";
import { createProject } from "../worker/db/projects";
import type { Env } from "../worker/env";
import { createApp } from "../worker/index";
import { ClassificationError } from "../worker/llm/types";
import { FakeProvider, FakeTelegram, classified, makeAccessKey, resetDb } from "./helpers";

const AUD = "test-aud";
const accessEnv: Env = { ...env, ACCESS_TEAM_DOMAIN: "testteam", ACCESS_AUD: AUD };

let key: Awaited<ReturnType<typeof makeAccessKey>>;
let token: string;
let provider: FakeProvider;
let telegram: FakeTelegram;

beforeAll(async () => {
  key = await makeAccessKey();
  const now = Math.floor(Date.now() / 1000);
  token = await key.sign({ iss: "https://testteam.cloudflareaccess.com", aud: [AUD], exp: now + 3600, email: "me@x.sk", sub: "u" });
});

beforeEach(async () => {
  await resetDb();
  clearAccessKeyCache();
  provider = new FakeProvider(() => ({ item: classified(), model: "fake-model" }));
  telegram = new FakeTelegram();
});

function app() {
  return createApp(() => ({
    db: env.DB,
    telegram,
    llm: () => provider,
    accessKeys: async () => [key.jwk as AccessJwk],
  }));
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { "Cf-Access-Jwt-Assertion": token, ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await app().fetch(new Request(`https://gtd.example/api${path}`, init), accessEnv);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { item: Item; items: Item[] } };
}

async function seed(raw: string, fields: Parameters<typeof updateItem>[2] = {}) {
  const id = await insertItem(env.DB, {
    source: "text",
    raw_text: raw,
    telegram_chat_id: 1,
    telegram_message_id: 1,
    telegram_file_id: null,
    pipeline_log: [],
  });
  await env.DB.prepare("UPDATE items SET title = ? WHERE id = ?").bind(raw, id).run();
  if (Object.keys(fields).length) {
    await updateItem(env.DB, id, fields);
    if (fields.reviewed === undefined) await env.DB.prepare("UPDATE items SET reviewed_at = NULL WHERE id = ?").bind(id).run();
  }
  return id;
}

describe("auth", () => {
  it("rejects requests without a token", async () => {
    const res = await app().fetch(new Request("https://gtd.example/api/items"), accessEnv);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid token", async () => {
    expect((await call("GET", "/items", undefined, { "Cf-Access-Jwt-Assertion": `${token}x` })).status).toBe(401);
  });

  it("accepts the CF_Authorization cookie", async () => {
    const res = await app().fetch(
      new Request("https://gtd.example/api/me", { headers: { Cookie: `CF_Authorization=${token}` } }),
      accessEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "me@x.sk", sub: "u" });
  });

  it("refuses cross-site requests", async () => {
    expect((await call("DELETE", "/items/1", undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  });

  it("fails closed when Access is not configured", async () => {
    const res = await exports.default.fetch(new Request("https://gtd.example/api/health"));
    expect(res.status).toBe(503);
  });

  it("lets wrangler dev on localhost through when Access is not configured", async () => {
    const res = await exports.default.fetch(new Request("http://localhost:8787/api/health"));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/items", () => {
  it("inbox is the unreviewed queue plus anything still in status inbox, oldest first", async () => {
    const a = await seed("first");
    const b = await seed("second", { status: "next" });
    await env.DB.prepare("UPDATE items SET reviewed_at = NULL WHERE id = ?").bind(b).run();
    // Approved while the AI left it in status 'inbox' (e.g. "hi"): it must not vanish from every list.
    const c = await seed("approved but unsorted", { reviewed: true });
    await seed("approved and sorted", { status: "next", reviewed: true });
    await seed("done", { status: "done" });

    const { json } = await call("GET", "/items?view=inbox");
    expect(json.items.map((i) => i.id)).toEqual([a, b, c]);
    expect((await call("GET", "/counts")).json.inbox).toBe(3);
  });

  it("filters by status view, project, context and search text", async () => {
    const project = await createProject(env.DB, { name: "Thesis" });
    const a = await seed("Email the professor", { status: "next", context: "@pc", project_id: project });
    await seed("Buy milk", { status: "next", context: "@errands" });
    await seed("Waiting on Peter", { status: "waiting" });

    expect((await call("GET", "/items?view=next")).json.items).toHaveLength(2);
    expect((await call("GET", "/items?view=next&context=%40pc")).json.items.map((i) => i.id)).toEqual([a]);
    expect((await call("GET", `/items?view=all&project_id=${project}`)).json.items.map((i) => i.id)).toEqual([a]);
    expect((await call("GET", "/items?view=all&q=PROFESSOR")).json.items.map((i) => i.id)).toEqual([a]);
    expect((await call("GET", "/items?view=all&q=50%25")).json.items).toHaveLength(0);
  });

  it("orders next actions by user priority", async () => {
    const low = await seed("low", { status: "next", priority: "low" });
    const none = await seed("none", { status: "next" });
    const high = await seed("high", { status: "next", priority: "high" });
    expect((await call("GET", "/items?view=next")).json.items.map((i) => i.id)).toEqual([high, low, none]);
  });

  it("rejects an unknown view", async () => {
    expect((await call("GET", "/items?view=bogus")).status).toBe(400);
  });
});

describe("GET /api/counts and /api/contexts", () => {
  it("counts items per view", async () => {
    await seed("a");
    await seed("b", { status: "next", context: "@pc" });
    await seed("c", { status: "deleted" });
    await env.DB.prepare("UPDATE items SET needs_review = 1 WHERE title = 'a'").run();

    const { json } = await call("GET", "/counts");
    expect(json).toMatchObject({ inbox: 2, next: 1, deleted: 1, all: 2, needs_review: 1, done: 0 });
    expect((await call("GET", "/contexts")).json).toEqual({ contexts: ["@pc"] });
  });
});

describe("PATCH /api/items/:id", () => {
  it("edits fields, sets priority and approves", async () => {
    const id = await seed("raw");
    const { status, json } = await call("PATCH", `/items/${id}`, {
      title: "  Clean title ",
      priority: "high",
      due_date: "2026-11-01",
      notes: "",
      reviewed: true,
    });
    expect(status).toBe(200);
    expect(json.item).toMatchObject({ title: "Clean title", priority: "high", due_date: "2026-11-01", notes: null });
    expect(json.item.reviewed_at).not.toBeNull();
  });

  it("a status change marks the item reviewed; reviewed:false sends it back", async () => {
    const id = await seed("raw");
    expect((await call("PATCH", `/items/${id}`, { status: "waiting" })).json.item.reviewed_at).not.toBeNull();
    expect((await call("PATCH", `/items/${id}`, { reviewed: false })).json.item.reviewed_at).toBeNull();
  });

  it("validates input", async () => {
    const id = await seed("raw");
    expect((await call("PATCH", `/items/${id}`, { status: "bogus" })).status).toBe(400);
    expect((await call("PATCH", `/items/${id}`, { due_date: "next friday" })).status).toBe(400);
    expect((await call("PATCH", `/items/${id}`, { ai_model: "x" })).status).toBe(400);
    expect((await call("PATCH", `/items/${id}`, { project_id: 999 })).status).toBe(400);
    expect((await call("PATCH", "/items/999", { title: "x" })).status).toBe(404);
  });

  it("links an item to an existing project", async () => {
    const id = await seed("raw");
    const project = await createProject(env.DB, { name: "P" });
    expect((await call("PATCH", `/items/${id}`, { project_id: project })).json.item.project_id).toBe(project);
  });
});

describe("DELETE /api/items/:id", () => {
  it("soft-deletes and can be restored", async () => {
    const id = await seed("raw");
    expect((await call("DELETE", `/items/${id}`)).json.item.status).toBe("deleted");
    expect((await call("PATCH", `/items/${id}`, { status: "next" })).json.item.status).toBe("next");
    expect((await call("DELETE", "/items/999")).status).toBe(404);
  });
});

describe("POST /api/items", () => {
  it("captures and classifies a note without a Telegram reply", async () => {
    const { status, json } = await call("POST", "/items", { text: "napísať profesorovi" });
    expect(status).toBe(201);
    expect(json.item).toMatchObject({ raw_text: "napísať profesorovi", title: "Email the professor", status: "next" });
    expect(json.item.pipeline_log.map((e) => e.step)).toEqual(["received", "classified", "saved"]);
    expect(telegram.sent).toHaveLength(0);
  });

  it("can skip classification", async () => {
    const { json } = await call("POST", "/items", { text: "raw thought", classify: false });
    expect(json.item).toMatchObject({ raw_text: "raw thought", title: null, status: "inbox" });
    expect(provider.inputs).toHaveLength(0);
  });

  it("rejects empty text", async () => {
    expect((await call("POST", "/items", { text: "  " })).status).toBe(400);
  });
});

describe("POST /api/items/:id/reclassify", () => {
  it("re-runs the AI on a note that failed", async () => {
    provider = new FakeProvider(() => {
      throw new ClassificationError("boom");
    });
    const { json: created } = await call("POST", "/items", { text: "kúpiť mlieko" });
    expect(created.item.needs_review).toBe(1);

    provider = new FakeProvider(() => ({ item: classified({ title: "Buy milk" }), model: "fake-model" }));
    const { json } = await call("POST", `/items/${created.item.id}/reclassify`);
    expect(json.item).toMatchObject({ title: "Buy milk", needs_review: 0 });
    expect(json.item.pipeline_log.map((e) => e.step)).toEqual([
      "received", "error", "saved", "reclassify", "classified", "saved",
    ]);
  });

  it("downloads the voice file again for voice notes", async () => {
    const id = await insertItem(env.DB, {
      source: "voice",
      raw_text: null,
      telegram_chat_id: 1,
      telegram_message_id: 1,
      telegram_file_id: "voice-file",
      pipeline_log: [],
    });
    provider = new FakeProvider(() => ({ item: classified({ transcript: "ahoj" }), model: "fake-model" }));
    await call("POST", `/items/${id}/reclassify`);
    expect(telegram.downloads).toEqual(["voice-file"]);
    expect((await getItem(env.DB, id))?.transcript).toBe("ahoj");
  });
});

describe("projects", () => {
  it("creates, lists with counts and updates", async () => {
    const { status, json } = await call("POST", "/projects", { name: "Thesis", outcome: "Submitted by June" });
    expect(status).toBe(201);
    const project = json.project as { id: number };
    await seed("write intro", { status: "next", project_id: project.id });
    await seed("read paper", { status: "someday", project_id: project.id });
    await seed("old", { status: "done", project_id: project.id });

    const list = (await call("GET", "/projects")).json.projects as Array<Record<string, unknown>>;
    expect(list).toEqual([
      expect.objectContaining({ name: "Thesis", outcome: "Submitted by June", open_items: 2, next_actions: 1 }),
    ]);

    const patched = await call("PATCH", `/projects/${project.id}`, { status: "done" });
    expect(patched.json.project).toMatchObject({ status: "done" });
    expect((await call("PATCH", `/projects/${project.id}`, { status: "nope" })).status).toBe(400);
    expect((await call("PATCH", "/projects/999", { name: "x" })).status).toBe(404);
  });
});
