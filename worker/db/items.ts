import type { ClassifiedItem } from "../llm/types";

export type ItemSource = "text" | "voice";
export type ItemStatus = "inbox" | "next" | "waiting" | "scheduled" | "someday" | "done" | "deleted";
export type ItemType = "task" | "project" | "idea" | "reference" | "someday";

export interface PipelineLogEntry {
  step: string;
  at: string;
  detail?: string;
  error?: string;
}

/** A row of `items` with pipeline_log decoded. */
export interface Item {
  id: number;
  created_at: string;
  updated_at: string;
  source: ItemSource;
  raw_text: string | null;
  transcript: string | null;
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
  telegram_file_id: string | null;
  bot_message_id: number | null;
  title: string | null;
  next_action: string | null;
  notes: string | null;
  type: ItemType | null;
  status: ItemStatus;
  project_id: number | null;
  context: string | null;
  time_estimate_min: number | null;
  energy: "low" | "medium" | "high" | null;
  steps_count: number | null;
  priority: "high" | "medium" | "low" | null;
  suggested_priority: "high" | "medium" | "low" | null;
  due_date: string | null;
  ai_confidence: number | null;
  ai_model: string | null;
  language: string | null;
  needs_review: number;
  reviewed_at: string | null;
  pipeline_log: PipelineLogEntry[];
}

type ItemRow = Omit<Item, "pipeline_log"> & { pipeline_log: string };

function decode(row: ItemRow): Item {
  let log: PipelineLogEntry[] = [];
  try {
    log = JSON.parse(row.pipeline_log) as PipelineLogEntry[];
  } catch {
    // keep empty; never fail a read because of a log column
  }
  return { ...row, pipeline_log: log };
}

export interface NewItem {
  source: ItemSource;
  raw_text: string | null;
  telegram_chat_id: number;
  telegram_message_id: number;
  telegram_file_id: string | null;
  pipeline_log: PipelineLogEntry[];
}

export async function insertItem(db: D1Database, item: NewItem): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO items (source, raw_text, telegram_chat_id, telegram_message_id, telegram_file_id, pipeline_log)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      item.source,
      item.raw_text,
      item.telegram_chat_id,
      item.telegram_message_id,
      item.telegram_file_id,
      JSON.stringify(item.pipeline_log),
    )
    .first<{ id: number }>();
  if (!row) throw new Error("insert returned no id");
  return row.id;
}

export async function saveClassification(
  db: D1Database,
  id: number,
  c: ClassifiedItem,
  model: string,
  log: PipelineLogEntry[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE items SET
         transcript = COALESCE(?, transcript), title = ?, next_action = ?, notes = ?, type = ?, status = ?,
         context = ?, time_estimate_min = ?, energy = ?, steps_count = ?, suggested_priority = ?,
         due_date = ?, ai_confidence = ?, ai_model = ?, language = ?, needs_review = 0,
         pipeline_log = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(
      c.transcript,
      c.title,
      c.next_action,
      c.notes,
      c.type,
      c.status,
      c.context,
      c.time_estimate_min,
      c.energy,
      c.steps_count,
      c.suggested_priority,
      c.due_date,
      c.confidence,
      model,
      c.language,
      JSON.stringify(log),
      id,
    )
    .run();
}

/** Classification failed: keep the raw note in the inbox and flag it. */
export async function markNeedsReview(
  db: D1Database,
  id: number,
  fields: { transcript: string | null; ai_model: string | null },
  log: PipelineLogEntry[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE items SET status = 'inbox', needs_review = 1,
         transcript = COALESCE(?, transcript), ai_model = COALESCE(?, ai_model),
         pipeline_log = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(fields.transcript, fields.ai_model, JSON.stringify(log), id)
    .run();
}

export async function setBotMessageId(db: D1Database, id: number, botMessageId: number): Promise<void> {
  await db.prepare(`UPDATE items SET bot_message_id = ? WHERE id = ?`).bind(botMessageId, id).run();
}

export async function getItem(db: D1Database, id: number): Promise<Item | null> {
  const row = await db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first<ItemRow>();
  return row ? decode(row) : null;
}

/** User action from the bot: change status and mark reviewed. */
export async function setStatusReviewed(db: D1Database, id: number, status: ItemStatus): Promise<void> {
  await db
    .prepare(
      `UPDATE items SET status = ?, reviewed_at = COALESCE(reviewed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(status, id)
    .run();
}

export async function listUnreviewed(db: D1Database, limit = 20): Promise<Item[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM items WHERE reviewed_at IS NULL AND status NOT IN ('done', 'deleted')
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .bind(limit)
    .all<ItemRow>();
  return results.map(decode);
}

export async function listQuickNextActions(db: D1Database, maxMinutes = 15, limit = 20): Promise<Item[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM items
       WHERE status = 'next' AND time_estimate_min IS NOT NULL AND time_estimate_min <= ?
       ORDER BY (priority IS NULL), CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                time_estimate_min ASC, id ASC
       LIMIT ?`,
    )
    .bind(maxMinutes, limit)
    .all<ItemRow>();
  return results.map(decode);
}
