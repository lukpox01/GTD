import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../worker/index";
import { isAllowedChat, verifySecretToken } from "../worker/telegram/webhook";
import { ALLOWED_CHAT, FakeProvider, FakeTelegram, classified, resetDb, textUpdate } from "./helpers";

const SECRET = "test-webhook-secret";

function post(body: unknown, secret?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== undefined) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request("https://gtd.example/telegram/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function itemCount() {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(resetDb);

describe("verifySecretToken", () => {
  it("accepts only the exact secret", () => {
    expect(verifySecretToken(SECRET, SECRET)).toBe(true);
    expect(verifySecretToken("wrong", SECRET)).toBe(false);
    expect(verifySecretToken(SECRET + "x", SECRET)).toBe(false);
    expect(verifySecretToken(SECRET.toUpperCase(), SECRET)).toBe(false);
    expect(verifySecretToken(undefined, SECRET)).toBe(false);
    expect(verifySecretToken("", SECRET)).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    expect(verifySecretToken("", "")).toBe(false);
    expect(verifySecretToken("anything", "")).toBe(false);
  });
});

describe("isAllowedChat", () => {
  it("matches the configured chat for messages and callbacks", () => {
    expect(isAllowedChat(textUpdate("hi", 4242), "4242")).toBe(true);
    expect(isAllowedChat(textUpdate("hi", 1), "4242")).toBe(false);
    expect(isAllowedChat({ update_id: 1, callback_query: { id: "x", from: { id: 4242 } } }, "4242")).toBe(true);
    expect(isAllowedChat({ update_id: 1 }, "4242")).toBe(false);
    expect(isAllowedChat(textUpdate("hi", 4242), "")).toBe(false);
  });
});

describe("POST /telegram/webhook (deployed worker)", () => {
  it("rejects a missing secret header with 401", async () => {
    const res = await exports.default.fetch(post(textUpdate("hi")));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong secret with 401", async () => {
    const res = await exports.default.fetch(post(textUpdate("hi"), "nope"));
    expect(res.status).toBe(401);
  });

  it("returns 400 for a malformed body", async () => {
    const res = await exports.default.fetch(post("{not json", SECRET));
    expect(res.status).toBe(400);
  });

  it("answers 200 but ignores other chats", async () => {
    const res = await exports.default.fetch(post(textUpdate("buy milk", 999), SECRET));
    expect(res.status).toBe(200);
    expect(await itemCount()).toBe(0);
  });
});

describe("POST /telegram/webhook (with fakes)", () => {
  async function deliver(app: ReturnType<typeof createApp>, body: unknown) {
    const ctx = createExecutionContext();
    const res = await app.fetch(post(body, SECRET), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("acks immediately and processes the note in waitUntil", async () => {
    const telegram = new FakeTelegram();
    const provider = new FakeProvider(() => ({ item: classified(), model: "fake-model" }));
    const app = createApp(() => ({ db: env.DB, telegram, llm: () => provider }));

    const res = await deliver(app, textUpdate("email the prof"));
    expect(res.status).toBe(200);
    expect(await itemCount()).toBe(1);
    expect(telegram.sent[0]?.chatId).toBe(ALLOWED_CHAT);
  });

  it("processes a retried update only once", async () => {
    const telegram = new FakeTelegram();
    const provider = new FakeProvider(() => ({ item: classified(), model: "fake-model" }));
    const app = createApp(() => ({ db: env.DB, telegram, llm: () => provider }));

    const update = textUpdate("email the prof");
    await deliver(app, update);
    await deliver(app, update);
    expect(await itemCount()).toBe(1);
    expect(provider.inputs).toHaveLength(1);
  });

  it("routes commands instead of classifying them", async () => {
    const telegram = new FakeTelegram();
    const provider = new FakeProvider(() => ({ item: classified(), model: "fake-model" }));
    const app = createApp(() => ({ db: env.DB, telegram, llm: () => provider }));

    await deliver(app, textUpdate("/help"));
    expect(provider.inputs).toHaveLength(0);
    expect(await itemCount()).toBe(0);
    expect(telegram.sent[0]?.text).toContain("/inbox");
  });
});
