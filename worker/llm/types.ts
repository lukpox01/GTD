import type { PromptProject } from "./prompt";
import type { ClassifiedItem } from "./schema";

export type { ClassifiedItem };

export interface ClassifyInput {
  text?: string;
  audio?: { bytes: Uint8Array; mimeType: string };
  /** The user's active projects, so the model can file the note under one of them. */
  projects?: PromptProject[];
}

export interface ClassifyResult {
  item: ClassifiedItem;
  /** Model id that produced the result, stored in items.ai_model. */
  model: string;
  /** Token counts reported by the provider, when available. */
  usage?: { input: number; output: number; thoughts: number };
}

/**
 * Every LLM backend implements this. A text-only provider (e.g. Claude) must
 * transcribe audio itself (separate transcription step) before classifying and
 * fill `item.transcript`.
 */
export interface LlmProvider {
  readonly name: string;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}

/** Thrown by providers. Carries whatever was salvageable so the pipeline can store it. */
export class ClassificationError extends Error {
  constructor(
    message: string,
    readonly details: { model?: string; rawOutput?: string; partialTranscript?: string | null } = {},
  ) {
    super(message);
    this.name = "ClassificationError";
  }
}
