import type { Item } from "./api";

export const TYPE_ICON: Record<NonNullable<Item["type"]>, string> = {
  task: "📌",
  project: "🗂",
  idea: "💡",
  reference: "📎",
  someday: "🌙",
};

export function displayTitle(item: Item): string {
  const text = item.title ?? item.raw_text ?? item.transcript ?? "(voice note)";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** "today", "tomorrow", "in 3 days", "2 days ago" or the date itself. */
export function relativeDue(date: string, today = new Date()): { label: string; overdue: boolean; soon: boolean } {
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = date.split("-").map(Number);
  const days = Math.round((Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) - t) / 86_400_000);
  const label =
    days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday"
    : days > 1 && days < 7 ? `in ${days} days` : days < 0 && days > -7 ? `${-days} days ago` : date;
  return { label, overdue: days < 0, soon: days >= 0 && days <= 2 };
}

export function minutes(n: number): string {
  return n < 60 ? `${n} min` : n % 60 === 0 ? `${n / 60} h` : `${Math.floor(n / 60)} h ${n % 60} min`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return iso.slice(0, 10);
}
