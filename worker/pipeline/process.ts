import { getItem, insertItem, markNeedsReview, saveClassification, setBotMessageId, type PipelineLogEntry } from "../db/items";
import type { Deps } from "../deps";
import { ClassificationError, type ClassifyInput } from "../llm/types";
import { formatItemMessage, itemKeyboard } from "../telegram/format";
import type { TgMessage } from "../telegram/types";

export type Note =
  | { kind: "text"; text: string }
  | { kind: "voice"; fileId: string; mimeType: string; durationSec: number };

/** What classification needs; also used to re-run it on a saved item. */
export type ClassifySource = { kind: "text"; text: string } | { kind: "voice"; fileId: string; mimeType: string };

type Step = (step: string, extra?: Omit<PipelineLogEntry, "step" | "at">) => void;

function stepper(log: PipelineLogEntry[]): Step {
  return (step, extra = {}) => log.push({ step, at: new Date().toISOString(), ...extra });
}

/**
 * received → (audio_downloaded) → classified/transcribed → saved → replied.
 * The raw note is written to D1 before any network call, so it is never lost:
 * on any failure the item stays in the inbox with needs_review = 1.
 */
export async function processNote(deps: Deps, message: TgMessage, note: Note): Promise<number> {
  const log: PipelineLogEntry[] = [];
  const step = stepper(log);

  step("received", { detail: note.kind === "voice" ? `voice ${note.durationSec}s ${note.mimeType}` : "text" });
  const id = await insertItem(deps.db, {
    source: note.kind,
    raw_text: note.kind === "text" ? note.text : null,
    telegram_chat_id: message.chat.id,
    telegram_message_id: message.message_id,
    telegram_file_id: note.kind === "voice" ? note.fileId : null,
    pipeline_log: log,
  });

  await classifyInto(deps, id, note, log);

  const saved = await getItem(deps.db, id);
  if (saved) {
    const sent = await deps.telegram.sendMessage(message.chat.id, formatItemMessage(saved), itemKeyboard(id));
    await setBotMessageId(deps.db, id, sent.message_id);
  }
  return id;
}

/**
 * (voice: download) → classify → save fields. Appends to `log`. On any failure the item is put
 * back in the inbox with needs_review = 1; never throws for LLM or download errors.
 */
export async function classifyInto(
  deps: Deps,
  id: number,
  source: ClassifySource,
  log: PipelineLogEntry[],
): Promise<void> {
  const step = stepper(log);
  try {
    const input: ClassifyInput = {};
    if (source.kind === "text") {
      input.text = source.text;
    } else {
      const bytes = await deps.telegram.downloadFile(source.fileId);
      step("audio_downloaded", { detail: `${bytes.length} bytes` });
      input.audio = { bytes, mimeType: source.mimeType };
    }

    const started = Date.now();
    const { item, model, usage } = await deps.llm().classify(input);
    const ms = Date.now() - started;
    if (source.kind === "voice") step("transcribed", { detail: `${item.transcript?.length ?? 0} chars` });
    const tokens = usage ? ` · tokens in ${usage.input} out ${usage.output} thinking ${usage.thoughts}` : "";
    step("classified", { detail: `${model} · ${item.type} · confidence ${item.confidence} · ${ms} ms${tokens}` });
    step("saved");
    await saveClassification(deps.db, id, item, model, log);
  } catch (e) {
    const err = e instanceof ClassificationError ? e : null;
    step("error", {
      error: e instanceof Error ? e.message : String(e),
      ...(err?.details.rawOutput ? { detail: `raw LLM output: ${err.details.rawOutput.slice(0, 2000)}` } : {}),
    });
    step("saved", { detail: "raw note kept in inbox, needs review" });
    await markNeedsReview(
      deps.db,
      id,
      { transcript: err?.details.partialTranscript ?? null, ai_model: err?.details.model ?? null },
      log,
    );
  }
}
