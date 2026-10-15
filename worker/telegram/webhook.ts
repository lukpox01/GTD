import type { Deps } from "../deps";
import { processNote } from "../pipeline/process";
import { handleCallback } from "./callbacks";
import { runCommand } from "./commands";
import type { TgUpdate } from "./types";

/** Constant-time comparison of the X-Telegram-Bot-Api-Secret-Token header. */
export function verifySecretToken(header: string | null | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const enc = new TextEncoder();
  const a = enc.encode(header);
  const b = enc.encode(secret);
  if (a.byteLength !== b.byteLength) {
    crypto.subtle.timingSafeEqual(b, b); // keep timing independent of where the mismatch is
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

/** The chat an update belongs to, for the ALLOWED_CHAT_ID check. */
export function updateChatId(update: TgUpdate): number | undefined {
  return (
    update.message?.chat.id ??
    update.edited_message?.chat.id ??
    update.callback_query?.message?.chat.id ??
    update.callback_query?.from.id
  );
}

export function isAllowedChat(update: TgUpdate, allowedChatId: string): boolean {
  const chatId = updateChatId(update);
  return chatId !== undefined && allowedChatId.trim() !== "" && String(chatId) === allowedChatId.trim();
}

/** Returns false if this update_id was already processed (Telegram retry). */
export async function claimUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const res = await db.prepare(`INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)`).bind(updateId).run();
  return res.meta.changes > 0;
}

/** Runs inside ctx.waitUntil(), after Telegram already got its 200. */
export async function handleUpdate(deps: Deps, update: TgUpdate): Promise<void> {
  if (!(await claimUpdate(deps.db, update.update_id))) return;

  if (update.callback_query) {
    await handleCallback(deps, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message) return; // edits, channel posts, etc. are ignored

  if (message.text !== undefined) {
    if (await runCommand(deps, message.chat.id, message.text)) return;
    if (message.text.trim() === "") return;
    await processNote(deps, message, { kind: "text", text: message.text });
    return;
  }

  if (message.voice) {
    await processNote(deps, message, {
      kind: "voice",
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type ?? "audio/ogg",
      durationSec: message.voice.duration,
    });
    return;
  }

  await deps.telegram.sendMessage(message.chat.id, "I can only file text and voice messages for now.");
}
