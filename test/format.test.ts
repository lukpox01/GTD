import { describe, expect, it } from "vitest";
import type { Item } from "../worker/db/items";
import { formatItemMessage, summaryLine } from "../worker/telegram/format";
import { formatToday } from "../worker/llm/prompt";

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: 7,
    created_at: "",
    updated_at: "",
    source: "text",
    raw_text: "raw",
    transcript: null,
    telegram_chat_id: 1,
    telegram_message_id: 1,
    telegram_file_id: null,
    bot_message_id: null,
    title: "Email the professor",
    next_action: "Email the professor",
    notes: null,
    type: "task",
    status: "next",
    project_id: null,
    context: "@pc",
    time_estimate_min: 10,
    energy: "low",
    steps_count: 1,
    priority: null,
    suggested_priority: null,
    due_date: null,
    ai_confidence: 0.9,
    ai_model: "m",
    language: "en",
    needs_review: 0,
    reviewed_at: null,
    pipeline_log: [],
    ...overrides,
  };
}

describe("format", () => {
  it("renders the summary line", () => {
    expect(summaryLine(item())).toBe("📌 Email the professor · 10 min · @pc · next");
    expect(summaryLine(item({ type: "idea", time_estimate_min: null, context: null, status: "someday" }))).toBe(
      "💡 Email the professor · someday",
    );
  });

  it("falls back to the raw text for unclassified items", () => {
    expect(summaryLine(item({ title: null, type: null, status: "inbox", time_estimate_min: null, context: null }))).toBe(
      "📥 raw · inbox",
    );
  });

  it("shows next action only when it differs from the title, plus due date and state", () => {
    const text = formatItemMessage(
      item({ next_action: "Open Gmail", due_date: "2026-10-17", status: "done", reviewed_at: "x" }),
    );
    expect(text).toContain("➡️ Open Gmail");
    expect(text).toContain("📅 due 2026-10-17");
    expect(text).toContain("✅ Done");
    expect(text).toContain("#7");
    expect(formatItemMessage(item())).not.toContain("➡️");
  });

  it("formats today's date in the user's timezone", () => {
    // 23:30 UTC on the 15th is already the 16th in Bratislava (UTC+2 in October)
    expect(formatToday(new Date("2026-10-15T23:30:00Z"), "Europe/Bratislava")).toBe("Friday 2026-10-16");
  });
});
