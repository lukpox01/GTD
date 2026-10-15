import { getItem, insertItem, markNeedsReview, saveClassification, setBotMessageId, type PipelineLogEntry } from "../db/items";
import type { Deps } from "../deps";
import { ClassificationError, type ClassifyInput } from "../llm/types";
import { formatItemMessage, itemKeyboard } from "../telegram/format";
import type { TgMessage } from "../telegram/types";

export type Note =
  | { kind: "text"; text: string }
  | { kind: "voice"; fileId: string; mimeType: string; durationSec: number };

/**
 * received → (audio_downloaded) → classified/transcribed → saved → replied.
 * The raw note is written to D1 before any network call, so it is never lost:
 * on any failure the item stays in the inbox with needs_review = 1.
 */
export async function processNote(deps: Deps, message: TgMessage, note: Note): Promise<number> {
  const log: PipelineLogEntry[] = [];
  const step = (s: string, extra: Omit<PipelineLogEntry, "step" | "at"> = {}) =>
    log.push({ step: s, at: new Date().toISOString(), ...extra });

  step("received", { detail: note.kind === "voice" ? `voice ${note.durationSec}s ${note.mimeType}` : "text" });
  const id = await insertItem(deps.db, {
    source: note.kind,
    raw_text: note.kind === "text" ? note.text : null,
    telegram_chat_id: message.chat.id,
    telegram_message_id: message.message_id,
    telegram_file_id: note.kind === "voice" ? note.fileId : null,
    pipeline_log: log,
  });

  try {
    const input: ClassifyInput = {};
    if (note.kind === "text") {
      input.text = note.text;
    } else {
      const bytes = await deps.telegram.downloadFile(note.fileId);
      step("audio_downloaded", { detail: `${bytes.length} bytes` });
      input.audio = { bytes, mimeType: note.mimeType };
    }

    const { item, model } = await deps.llm().classify(input);
    if (note.kind === "voice") step("transcribed", { detail: `${item.transcript?.length ?? 0} chars` });
    step("classified", { detail: `${model} · ${item.type} · confidence ${item.confidence}` });
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

  const saved = await getItem(deps.db, id);
  if (saved) {
    const sent = await deps.telegram.sendMessage(message.chat.id, formatItemMessage(saved), itemKeyboard(id));
    await setBotMessageId(deps.db, id, sent.message_id);
  }
  return id;
}
