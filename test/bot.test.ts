import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getItem } from "../worker/db/items";
import { COMMANDS, parseCommand } from "../worker/telegram/commands";
import { parseCallbackData } from "../worker/telegram/format";
import { handleUpdate } from "../worker/telegram/webhook";
import { FakeProvider, callbackUpdate, classified, makeDeps, resetDb, textUpdate } from "./helpers";

beforeEach(resetDb);

async function captureItem(deps: ReturnType<typeof makeDeps>, text = "email the prof") {
  await handleUpdate(deps, textUpdate(text));
  const row = await env.DB.prepare("SELECT id FROM items ORDER BY id DESC").first<{ id: number }>();
  return row!.id;
}

describe("callback buttons", () => {
  it.each([
    ["done", "done", "✅ Done"],
    ["someday", "someday", "🌙 Someday"],
    ["delete", "deleted", "🗑 Deleted"],
  ] as const)("%s sets status %s, marks reviewed and edits the message", async (action, status, label) => {
    const deps = makeDeps(new FakeProvider(() => ({ item: classified(), model: "m" })));
    const id = await captureItem(deps);

    await handleUpdate(deps, callbackUpdate(`${action}:${id}`, 1000));

    const item = await getItem(env.DB, id);
    expect(item?.status).toBe(status);
    expect(item?.reviewed_at).not.toBeNull();
    expect(deps.telegram.answered).toHaveLength(1);
    expect(deps.telegram.edited[0]).toMatchObject({ messageId: 1000 });
    expect(deps.telegram.edited[0]?.text).toContain(label);
  });

  it("'Is project' creates one project, links the item and is idempotent", async () => {
    const deps = makeDeps(new FakeProvider(() => ({ item: classified({ title: "Plan the trip" }), model: "m" })));
    const id = await captureItem(deps);

    await handleUpdate(deps, callbackUpdate(`project:${id}`));
    await handleUpdate(deps, callbackUpdate(`project:${id}`));

    const projects = await env.DB.prepare("SELECT id, name FROM projects").all<{ id: number; name: string }>();
    expect(projects.results).toHaveLength(1);
    expect(projects.results[0]?.name).toBe("Plan the trip");
    const item = await getItem(env.DB, id);
    expect(item).toMatchObject({ type: "project", project_id: projects.results[0]?.id });
    expect(item?.reviewed_at).not.toBeNull();
  });

  it("answers gracefully for unknown data or a missing item", async () => {
    const deps = makeDeps(new FakeProvider(() => ({ item: classified(), model: "m" })));
    await handleUpdate(deps, callbackUpdate("explode:1"));
    await handleUpdate(deps, callbackUpdate("done:99999"));
    await handleUpdate(deps, callbackUpdate("project:99999"));
    expect(deps.telegram.answered.map((a) => a.text)).toEqual([
      "Unknown action",
      "Item #99999 not found",
      "Item #99999 not found",
    ]);
    expect(deps.telegram.edited).toHaveLength(0);
  });

  it("parses callback data strictly", () => {
    expect(parseCallbackData("done:12")).toEqual({ action: "done", itemId: 12 });
    expect(parseCallbackData("done:12:3")).toBeNull();
    expect(parseCallbackData("drop:12")).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
  });
});

describe("commands", () => {
  it("parses /cmd@BotName args", () => {
    expect(parseCommand("/inbox")).toEqual({ name: "inbox", args: "" });
    expect(parseCommand("/Quick@my_gtd_bot  20 ")).toEqual({ name: "quick", args: "20" });
    expect(parseCommand("/start")).toEqual({ name: "help", args: "" });
    expect(parseCommand("not a /command")).toBeNull();
  });

  it("/help lists every registered command", async () => {
    const deps = makeDeps(new FakeProvider(() => ({ item: classified(), model: "m" })));
    await handleUpdate(deps, textUpdate("/help"));
    for (const c of COMMANDS) expect(deps.telegram.sent[0]?.text).toContain(`/${c.name}`);
  });

  it("/inbox lists only unreviewed, non-deleted items", async () => {
    const deps = makeDeps(new FakeProvider((input) => ({ item: classified({ title: input.text! }), model: "m" })));
    await captureItem(deps, "Alpha");
    const reviewed = await captureItem(deps, "Beta");
    await captureItem(deps, "Gamma");
    await handleUpdate(deps, callbackUpdate(`someday:${reviewed}`));
    deps.telegram.sent = [];

    await handleUpdate(deps, textUpdate("/inbox"));

    const text = deps.telegram.sent[0]?.text ?? "";
    expect(text).toContain("Alpha");
    expect(text).toContain("Gamma");
    expect(text).not.toContain("Beta");
  });

  it("/quick lists next actions of 15 minutes or less", async () => {
    const deps = makeDeps(
      new FakeProvider((input) => {
        const [title, minutes, status] = input.text!.split("|");
        return {
          item: classified({ title, time_estimate_min: Number(minutes), status: status as "next" | "someday" }),
          model: "m",
        };
      }),
    );
    await captureItem(deps, "Short|5|next");
    await captureItem(deps, "Edge|15|next");
    await captureItem(deps, "Long|45|next");
    await captureItem(deps, "Later|5|someday");
    deps.telegram.sent = [];

    await handleUpdate(deps, textUpdate("/quick"));

    const text = deps.telegram.sent[0]?.text ?? "";
    expect(text).toContain("Short");
    expect(text).toContain("Edge");
    expect(text).not.toContain("Long");
    expect(text).not.toContain("Later");
    expect(text.indexOf("Short")).toBeLessThan(text.indexOf("Edge"));
  });

  it("replies to unknown commands", async () => {
    const deps = makeDeps(new FakeProvider(() => ({ item: classified(), model: "m" })));
    await handleUpdate(deps, textUpdate("/nope"));
    expect(deps.telegram.sent[0]?.text).toContain("Unknown command /nope");
  });
});
