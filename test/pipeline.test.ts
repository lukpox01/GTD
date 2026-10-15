import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getItem } from "../worker/db/items";
import { ClassificationError } from "../worker/llm/types";
import { handleUpdate } from "../worker/telegram/webhook";
import { FakeProvider, classified, makeDeps, resetDb, textUpdate, voiceUpdate } from "./helpers";

beforeEach(resetDb);

async function onlyItem() {
  const row = await env.DB.prepare("SELECT id FROM items").first<{ id: number }>();
  if (!row) throw new Error("no item saved");
  const item = await getItem(env.DB, row.id);
  if (!item) throw new Error("item vanished");
  return item;
}

describe("text note", () => {
  it("classifies, saves all fields and replies with buttons", async () => {
    const provider = new FakeProvider(() => ({
      item: classified(),
      model: "gemini-test",
      usage: { input: 900, output: 80, thoughts: 0 },
    }));
    const deps = makeDeps(provider);

    await handleUpdate(deps, textUpdate("ehm treba napisat profesorovi"));

    expect(provider.inputs[0]).toEqual({ text: "ehm treba napisat profesorovi" });
    const item = await onlyItem();
    expect(item).toMatchObject({
      source: "text",
      raw_text: "ehm treba napisat profesorovi",
      title: "Email the professor",
      type: "task",
      status: "next",
      context: "@pc",
      time_estimate_min: 10,
      suggested_priority: "medium",
      priority: null, // the AI never sets priority
      ai_model: "gemini-test",
      ai_confidence: 0.9,
      needs_review: 0,
      reviewed_at: null,
      bot_message_id: 1000,
    });
    expect(item.pipeline_log.map((e) => e.step)).toEqual(["received", "classified", "saved"]);
    expect(item.pipeline_log[1]?.detail).toMatch(/ms · tokens in 900 out 80 thinking 0$/);

    const reply = deps.telegram.sent[0];
    expect(reply?.text).toContain("📌 Email the professor · 10 min · @pc · next");
    expect(reply?.keyboard?.flat().map((b) => b.callback_data)).toEqual([
      `done:${item.id}`,
      `someday:${item.id}`,
      `delete:${item.id}`,
      `project:${item.id}`,
    ]);
  });

  it("keeps the raw note in the inbox and flags it when classification fails", async () => {
    const provider = new FakeProvider(() => {
      throw new ClassificationError("schema mismatch: title missing", { model: "gemini-test", rawOutput: "{oops" });
    });
    const deps = makeDeps(provider);

    await handleUpdate(deps, textUpdate("kúpiť mlieko a chlieb"));

    const item = await onlyItem();
    expect(item).toMatchObject({ raw_text: "kúpiť mlieko a chlieb", status: "inbox", needs_review: 1, title: null });
    expect(item.ai_model).toBe("gemini-test");
    const error = item.pipeline_log.find((e) => e.step === "error");
    expect(error?.error).toContain("title missing");
    expect(error?.detail).toContain("{oops");
    expect(deps.telegram.sent[0]?.text).toContain("AI sorting failed");
  });

  it("survives a non-ClassificationError (e.g. bad service-account secret)", async () => {
    const deps = makeDeps(new FakeProvider(() => ({ item: classified(), model: "x" })));
    deps.llm = () => {
      throw new Error("GCP_SERVICE_ACCOUNT_JSON is not valid JSON");
    };

    await handleUpdate(deps, textUpdate("call mom"));

    const item = await onlyItem();
    expect(item).toMatchObject({ raw_text: "call mom", status: "inbox", needs_review: 1 });
    expect(deps.telegram.sent).toHaveLength(1);
  });
});

describe("voice note", () => {
  it("downloads the audio, sends it inline and stores the transcript", async () => {
    const provider = new FakeProvider(() => ({
      item: classified({ transcript: "Treba napísať profesorovi.", language: "sk", title: "Napísať profesorovi" }),
      model: "gemini-test",
    }));
    const deps = makeDeps(provider);
    const update = voiceUpdate();

    await handleUpdate(deps, update);

    expect(deps.telegram.downloads).toEqual([update.message?.voice?.file_id]);
    expect(provider.inputs[0]?.audio?.mimeType).toBe("audio/ogg");
    expect(provider.inputs[0]?.audio?.bytes).toEqual(deps.telegram.fileBytes);
    expect(provider.inputs[0]?.text).toBeUndefined();

    const item = await onlyItem();
    expect(item).toMatchObject({
      source: "voice",
      raw_text: null,
      transcript: "Treba napísať profesorovi.",
      telegram_file_id: update.message?.voice?.file_id,
      language: "sk",
    });
    expect(item.pipeline_log.map((e) => e.step)).toEqual([
      "received",
      "audio_downloaded",
      "transcribed",
      "classified",
      "saved",
    ]);
    expect(deps.telegram.sent[0]?.text).toContain("🎙");
  });

  it("keeps a salvaged transcript when classification fails", async () => {
    const provider = new FakeProvider(() => {
      throw new ClassificationError("schema mismatch", { partialTranscript: "kúpiť mlieko" });
    });
    const deps = makeDeps(provider);

    await handleUpdate(deps, voiceUpdate());

    const item = await onlyItem();
    expect(item).toMatchObject({ transcript: "kúpiť mlieko", needs_review: 1, status: "inbox" });
    expect(item.telegram_file_id).toBeTruthy(); // can be re-processed later
  });
});
