import type { InlineKeyboard } from "./types";

/** The Telegram calls the bot needs. Tests substitute a fake. */
export interface TelegramApi {
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** getFile + download in one step. */
  downloadFile(fileId: string): Promise<Uint8Array>;
}

const MAX_TEXT = 4096;

export class TelegramClient implements TelegramApi {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly token: string,
    fetchFn?: typeof fetch,
  ) {
    this.fetchFn = fetchFn ?? fetch.bind(globalThis);
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !body.ok) {
      throw new Error(`Telegram ${method} failed (${res.status}): ${body.description ?? "unknown error"}`);
    }
    return body.result as T;
  }

  async sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard) {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: truncate(text),
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  async editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: truncate(text),
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch (e) {
      // Tapping the same button twice yields an identical message; that's fine.
      if (!String(e).includes("message is not modified")) throw e;
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("getFile returned no file_path");
    const res = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`file download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}
