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

export const ITEM_STATUSES = ["inbox", "next", "waiting", "scheduled", "someday", "done", "deleted"] as const;
export const ITEM_TYPES = ["task", "project", "idea", "reference", "someday"] as const;
export const LEVELS = ["high", "medium", "low"] as const;

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
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
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
         due_date = ?, project_id = COALESCE(project_id, ?), ai_confidence = ?, ai_model = ?, language = ?,
         needs_review = 0,
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
      c.project_id,
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

/** The bot's /inbox: same queue as the dashboard inbox. */
export async function listUnreviewed(db: D1Database, limit = 20): Promise<Item[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM items WHERE (reviewed_at IS NULL OR status = 'inbox') AND status NOT IN ('done', 'deleted')
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

/** Dashboard list views. `inbox` is the review queue (unreviewed or still status 'inbox'), the rest are statuses. */
export const ITEM_VIEWS = ["inbox", "next", "waiting", "scheduled", "someday", "done", "deleted", "all"] as const;
export type ItemView = (typeof ITEM_VIEWS)[number];

export interface ItemQuery {
  view: ItemView;
  projectId?: number;
  context?: string;
  /** Case-insensitive substring over title, next action, notes and the raw note. */
  q?: string;
  limit?: number;
}

const OPEN = `status NOT IN ('done', 'deleted')`;
/** Needs processing: never reviewed, or reviewed but not sorted out of status 'inbox' yet. */
const IN_INBOX = `(reviewed_at IS NULL OR status = 'inbox') AND ${OPEN}`;
const BY_PRIORITY = `(priority IS NULL), CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

export async function listItems(db: D1Database, query: ItemQuery): Promise<Item[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  let order = `${BY_PRIORITY}, (due_date IS NULL), due_date ASC, created_at ASC, id ASC`;

  switch (query.view) {
    case "inbox":
      where.push(IN_INBOX);
      order = "created_at ASC, id ASC";
      break;
    case "all":
      where.push(`status != 'deleted'`);
      order = "created_at DESC, id DESC";
      break;
    case "done":
    case "deleted":
      where.push("status = ?");
      binds.push(query.view);
      order = "updated_at DESC, id DESC";
      break;
    default:
      where.push("status = ?");
      binds.push(query.view);
  }
  if (query.projectId !== undefined) {
    where.push("project_id = ?");
    binds.push(query.projectId);
  }
  if (query.context) {
    where.push("context = ?");
    binds.push(query.context);
  }
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const cols = ["title", "next_action", "notes", "raw_text", "transcript"];
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    binds.push(...cols.map(() => like));
  }
  binds.push(Math.min(Math.max(query.limit ?? 200, 1), 500));

  const { results } = await db
    .prepare(`SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
    .bind(...binds)
    .all<ItemRow>();
  return results.map(decode);
}

/** Item counts per dashboard view, plus how many need attention because the AI failed. */
export async function countItems(db: D1Database): Promise<Record<ItemView | "needs_review", number>> {
  const row = await db
    .prepare(
      `SELECT
         SUM(${IN_INBOX}) AS inbox,
         SUM(status = 'next') AS next, SUM(status = 'waiting') AS waiting,
         SUM(status = 'scheduled') AS scheduled, SUM(status = 'someday') AS someday,
         SUM(status = 'done') AS done, SUM(status = 'deleted') AS deleted,
         SUM(status != 'deleted') AS "all",
         SUM(needs_review = 1 AND ${OPEN}) AS needs_review
       FROM items`,
    )
    .first<Record<string, number | null>>();
  const n = (k: string) => row?.[k] ?? 0;
  return {
    inbox: n("inbox"),
    next: n("next"),
    waiting: n("waiting"),
    scheduled: n("scheduled"),
    someday: n("someday"),
    done: n("done"),
    deleted: n("deleted"),
    all: n("all"),
    needs_review: n("needs_review"),
  };
}

export async function listContexts(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT context FROM items WHERE context IS NOT NULL AND status != 'deleted' ORDER BY context`)
    .all<{ context: string }>();
  return results.map((r) => r.context);
}

/** Fields the user can edit from the dashboard. `undefined` = leave as is, `null` = clear. */
export interface ItemPatch {
  title?: string | null;
  next_action?: string | null;
  notes?: string | null;
  type?: ItemType | null;
  status?: ItemStatus;
  project_id?: number | null;
  context?: string | null;
  time_estimate_min?: number | null;
  energy?: "low" | "medium" | "high" | null;
  priority?: "high" | "medium" | "low" | null;
  due_date?: string | null;
  /** true = approve (set reviewed_at if unset), false = back to the review queue. */
  reviewed?: boolean;
}

const PATCH_COLUMNS = [
  "title",
  "next_action",
  "notes",
  "type",
  "status",
  "project_id",
  "context",
  "time_estimate_min",
  "energy",
  "priority",
  "due_date",
] as const satisfies ReadonlyArray<keyof ItemPatch & keyof Item>;

/**
 * Apply a user edit. A status change counts as reviewing the item (same as a bot button).
 * Returns false if the item doesn't exist.
 */
export async function updateItem(db: D1Database, id: number, patch: ItemPatch): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of PATCH_COLUMNS) {
    if (patch[col] === undefined) continue;
    sets.push(`${col} = ?`);
    binds.push(patch[col]);
  }
  if (patch.reviewed === false) sets.push("reviewed_at = NULL");
  else if (patch.reviewed === true || patch.status !== undefined) {
    sets.push(`reviewed_at = COALESCE(reviewed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  }
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);

  const res = await db
    .prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  return res.meta.changes > 0;
}

export async function appendLog(db: D1Database, id: number, entry: PipelineLogEntry): Promise<PipelineLogEntry[]> {
  const item = await getItem(db, id);
  const log = [...(item?.pipeline_log ?? []), entry];
  await db.prepare(`UPDATE items SET pipeline_log = ? WHERE id = ?`).bind(JSON.stringify(log), id).run();
  return log;
}
