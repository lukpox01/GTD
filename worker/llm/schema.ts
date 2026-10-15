import { z } from "zod";

export const ITEM_TYPES = ["task", "project", "idea", "reference", "someday"] as const;
/** Statuses the classifier may suggest. done/deleted are only ever set by the user. */
export const SUGGESTED_STATUSES = ["inbox", "next", "waiting", "scheduled", "someday"] as const;
export const ENERGY_LEVELS = ["low", "medium", "high"] as const;
export const PRIORITIES = ["high", "medium", "low"] as const;

/**
 * Optional field: missing, null or invalid all become null, so one bad field
 * never throws away an otherwise good classification.
 */
function optional<T extends z.ZodType>(schema: T) {
  return schema.nullish().catch(null).transform((v) => v ?? null);
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  });

const contextTag = z
  .string()
  .trim()
  .min(1)
  .transform((s) => `@${s.replace(/^@+/, "").toLowerCase().replace(/\s+/g, "-")}`);

const trimmedText = z
  .string()
  .trim()
  .transform((s) => (s === "" ? null : s));

export const classifiedItemSchema = z.object({
  language: optional(z.enum(["sk", "en"])),
  transcript: optional(trimmedText),
  title: z.string().trim().min(1).max(200),
  next_action: optional(trimmedText),
  notes: optional(trimmedText),
  type: z.enum(ITEM_TYPES),
  status: z.enum(SUGGESTED_STATUSES).catch("inbox"),
  context: optional(contextTag),
  time_estimate_min: optional(z.number().int().min(1).max(60 * 24 * 7)),
  energy: optional(z.enum(ENERGY_LEVELS)),
  steps_count: optional(z.number().int().min(1).max(1000)),
  suggested_priority: optional(z.enum(PRIORITIES)),
  due_date: optional(isoDate),
  /** One of the active project ids given in the prompt; checked against that list by the pipeline. */
  project_id: optional(z.number().int().positive()),
  confidence: z.number().min(0).max(1).catch(0),
});

export type ClassifiedItem = z.output<typeof classifiedItemSchema>;

/**
 * Vertex AI `responseSchema` (OpenAPI 3.0 subset). Must describe the same keys
 * as `classifiedItemSchema`; a test enforces that.
 */
export const vertexResponseSchema = {
  type: "OBJECT",
  properties: {
    language: { type: "STRING", enum: ["sk", "en"], description: "Language of the note." },
    transcript: {
      type: "STRING",
      nullable: true,
      description: "Verbatim transcript of the audio. null for text notes.",
    },
    title: { type: "STRING", description: "Short task title in the note's language, max ~8 words." },
    next_action: {
      type: "STRING",
      nullable: true,
      description: "The very next physical, visible action, starting with a verb, in the note's language.",
    },
    notes: { type: "STRING", nullable: true, description: "Useful details from the note that are not in the title." },
    type: { type: "STRING", enum: [...ITEM_TYPES] },
    status: { type: "STRING", enum: [...SUGGESTED_STATUSES] },
    context: { type: "STRING", nullable: true, description: "GTD context such as @pc, @phone, @home, @school, @errands." },
    time_estimate_min: { type: "INTEGER", nullable: true, description: "Estimated minutes for the next action." },
    energy: { type: "STRING", enum: [...ENERGY_LEVELS], nullable: true },
    steps_count: { type: "INTEGER", nullable: true, description: "Rough number of steps to finish the whole thing." },
    suggested_priority: { type: "STRING", enum: [...PRIORITIES], nullable: true },
    due_date: {
      type: "STRING",
      nullable: true,
      description: "YYYY-MM-DD, ONLY if the note explicitly states a deadline or date. Otherwise null.",
    },
    project_id: {
      type: "INTEGER",
      nullable: true,
      description: "Id of the listed active project this note clearly belongs to. null if none fits or none are listed.",
    },
    confidence: { type: "NUMBER", description: "0..1, how confident you are in this classification." },
  },
  required: ["language", "transcript", "title", "next_action", "type", "status", "confidence"],
  propertyOrdering: [
    "language",
    "transcript",
    "title",
    "next_action",
    "notes",
    "type",
    "status",
    "context",
    "time_estimate_min",
    "energy",
    "steps_count",
    "suggested_priority",
    "due_date",
    "project_id",
    "confidence",
  ],
} as const;

export type ParseResult =
  | { ok: true; item: ClassifiedItem }
  | { ok: false; error: string; partialTranscript: string | null };

/** Parse and validate raw LLM output. Never throws. */
export function parseClassification(raw: string): ParseResult {
  const text = stripCodeFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}`, partialTranscript: null };
  }

  const result = classifiedItemSchema.safeParse(json);
  if (result.success) return { ok: true, item: result.data };

  return {
    ok: false,
    error: `schema mismatch: ${z.prettifyError(result.error)}`,
    partialTranscript: extractTranscript(json),
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return m?.[1] ?? trimmed;
}

function extractTranscript(json: unknown): string | null {
  if (json && typeof json === "object" && "transcript" in json) {
    const t = (json as { transcript: unknown }).transcript;
    if (typeof t === "string" && t.trim() !== "") return t.trim();
  }
  return null;
}
