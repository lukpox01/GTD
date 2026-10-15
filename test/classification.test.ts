import { describe, expect, it } from "vitest";
import { classifiedItemSchema, parseClassification, vertexResponseSchema } from "../worker/llm/schema";

const valid = {
  language: "sk",
  transcript: null,
  title: "Napísať profesorovi",
  next_action: "Napísať email profesorovi o termíne odovzdania",
  notes: "Spýtať sa aj na konzultácie",
  type: "task",
  status: "next",
  context: "@pc",
  time_estimate_min: 10,
  energy: "low",
  steps_count: 1,
  suggested_priority: "medium",
  due_date: "2026-10-17",
  confidence: 0.82,
};

describe("parseClassification", () => {
  it("accepts a valid response", () => {
    const r = parseClassification(JSON.stringify(valid));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.title).toBe("Napísať profesorovi");
      expect(r.item.due_date).toBe("2026-10-17");
      expect(r.item.language).toBe("sk");
    }
  });

  it("strips a markdown code fence", () => {
    const r = parseClassification("```json\n" + JSON.stringify(valid) + "\n```");
    expect(r.ok).toBe(true);
  });

  it("normalizes context tags", () => {
    const r = parseClassification(JSON.stringify({ ...valid, context: "  PC " }));
    expect(r.ok && r.item.context).toBe("@pc");
    const r2 = parseClassification(JSON.stringify({ ...valid, context: "@@Home Office" }));
    expect(r2.ok && r2.item.context).toBe("@home-office");
  });

  it("fills missing optional fields with null", () => {
    const { notes, context, energy, due_date, steps_count, suggested_priority, time_estimate_min, ...rest } = valid;
    const r = parseClassification(JSON.stringify(rest));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item).toMatchObject({ notes: null, context: null, energy: null, due_date: null, time_estimate_min: null });
    }
  });

  it("drops an invalid optional field instead of failing the whole note", () => {
    const r = parseClassification(
      JSON.stringify({ ...valid, due_date: "next friday", energy: "extreme", time_estimate_min: -5 }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.due_date).toBeNull();
      expect(r.item.energy).toBeNull();
      expect(r.item.time_estimate_min).toBeNull();
    }
  });

  it("rejects impossible calendar dates", () => {
    const r = parseClassification(JSON.stringify({ ...valid, due_date: "2026-02-30" }));
    expect(r.ok && r.item.due_date).toBeNull();
  });

  it("turns empty strings into null", () => {
    const r = parseClassification(JSON.stringify({ ...valid, notes: "   ", next_action: "" }));
    expect(r.ok && r.item.notes).toBeNull();
    expect(r.ok && r.item.next_action).toBeNull();
  });

  it("falls back to inbox for an unknown or user-only status", () => {
    const r = parseClassification(JSON.stringify({ ...valid, status: "done" }));
    expect(r.ok && r.item.status).toBe("inbox");
  });

  it("fails on non-JSON", () => {
    const r = parseClassification("Sure! Here is your task: email the professor");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/);
  });

  it("fails when a required field is missing or invalid", () => {
    expect(parseClassification(JSON.stringify({ ...valid, title: "" })).ok).toBe(false);
    expect(parseClassification(JSON.stringify({ ...valid, type: "chore" })).ok).toBe(false);
    expect(parseClassification("[]").ok).toBe(false);
    expect(parseClassification("null").ok).toBe(false);
  });

  it("salvages the transcript from an invalid response", () => {
    const r = parseClassification(JSON.stringify({ transcript: " kúpiť mlieko ", type: "??" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.partialTranscript).toBe("kúpiť mlieko");
  });
});

describe("vertexResponseSchema", () => {
  it("describes exactly the keys the zod schema validates", () => {
    const zodKeys = Object.keys(classifiedItemSchema.shape).sort();
    expect(Object.keys(vertexResponseSchema.properties).sort()).toEqual(zodKeys);
    expect([...vertexResponseSchema.propertyOrdering].sort()).toEqual(zodKeys);
    for (const key of vertexResponseSchema.required) expect(zodKeys).toContain(key);
  });
});
