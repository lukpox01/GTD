import type { Item, ItemType } from "../db/items";
import type { InlineKeyboard } from "./types";

const TYPE_ICON: Record<ItemType, string> = {
  task: "📌",
  project: "🗂",
  idea: "💡",
  reference: "📎",
  someday: "🌙",
};

const STATUS_LINE: Partial<Record<Item["status"], string>> = {
  done: "✅ Done",
  someday: "🌙 Someday",
  deleted: "🗑 Deleted",
};

export const CALLBACK_ACTIONS = ["done", "someday", "delete", "project"] as const;
export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

export function itemKeyboard(itemId: number): InlineKeyboard {
  return [
    [
      { text: "✅ Done", callback_data: `done:${itemId}` },
      { text: "🌙 Someday", callback_data: `someday:${itemId}` },
    ],
    [
      { text: "🗑 Delete", callback_data: `delete:${itemId}` },
      { text: "🗂 Is project", callback_data: `project:${itemId}` },
    ],
  ];
}

export function parseCallbackData(data: string | undefined): { action: CallbackAction; itemId: number } | null {
  const m = /^([a-z]+):(\d+)$/.exec(data ?? "");
  if (!m) return null;
  const action = m[1] as CallbackAction;
  if (!CALLBACK_ACTIONS.includes(action)) return null;
  return { action, itemId: Number(m[2]) };
}

/** "📌 Email the professor · 10 min · @pc · next" */
export function summaryLine(item: Item): string {
  const icon = item.type ? TYPE_ICON[item.type] : "📥";
  const title = item.title ?? excerpt(item.raw_text ?? item.transcript ?? "(voice note)", 60);
  const parts = [`${icon} ${title}`];
  if (item.time_estimate_min !== null) parts.push(`${item.time_estimate_min} min`);
  if (item.context) parts.push(item.context);
  parts.push(item.status);
  return parts.join(" · ");
}

/** Full bot reply for a captured item. Re-rendered from the DB row after every button tap. */
export function formatItemMessage(item: Item): string {
  const lines = [summaryLine(item)];
  if (item.needs_review) lines.push("⚠️ AI sorting failed — saved raw to your inbox.");
  if (item.next_action && item.next_action !== item.title) lines.push(`➡️ ${item.next_action}`);
  if (item.due_date) lines.push(`📅 due ${item.due_date}`);
  if (item.project_id !== null) lines.push(`🗂 project #${item.project_id}`);
  if (item.source === "voice" && item.transcript) lines.push(`🎙 “${excerpt(item.transcript, 300)}”`);
  const status = STATUS_LINE[item.status];
  if (status && item.reviewed_at) lines.push("", status);
  lines.push("", `#${item.id}`);
  return lines.join("\n");
}

/** One line per item for /inbox, /quick. */
export function formatItemList(header: string, items: Item[], empty: string): string {
  if (items.length === 0) return empty;
  return [header, "", ...items.map((i) => `#${i.id} ${summaryLine(i)}`)].join("\n");
}

function excerpt(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
