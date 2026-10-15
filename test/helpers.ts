import { env } from "cloudflare:test";
import type { Deps } from "../worker/deps";
import type { ClassifiedItem, ClassifyInput, ClassifyResult, LlmProvider } from "../worker/llm/types";
import type { TelegramApi } from "../worker/telegram/api";
import type { InlineKeyboard, TgUpdate } from "../worker/telegram/types";

export const ALLOWED_CHAT = 4242;

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM items"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM telegram_updates"),
  ]);
}

export class FakeTelegram implements TelegramApi {
  sent: Array<{ chatId: number; text: string; keyboard?: InlineKeyboard }> = [];
  edited: Array<{ chatId: number; messageId: number; text: string; keyboard?: InlineKeyboard }> = [];
  answered: Array<{ id: string; text?: string }> = [];
  downloads: string[] = [];
  fileBytes = new Uint8Array([79, 103, 103, 83]); // "OggS"
  private nextId = 1000;

  async sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard) {
    this.sent.push({ chatId, text, keyboard });
    return { message_id: this.nextId++ };
  }
  async editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) {
    this.edited.push({ chatId, messageId, text, keyboard });
  }
  async answerCallbackQuery(id: string, text?: string) {
    this.answered.push({ id, text });
  }
  async downloadFile(fileId: string) {
    this.downloads.push(fileId);
    return this.fileBytes;
  }
}

export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  inputs: ClassifyInput[] = [];
  constructor(private readonly behaviour: (input: ClassifyInput) => ClassifyResult | Promise<ClassifyResult>) {}
  async classify(input: ClassifyInput) {
    this.inputs.push(input);
    return this.behaviour(input);
  }
}

export function classified(overrides: Partial<ClassifiedItem> = {}): ClassifiedItem {
  return {
    language: "en",
    transcript: null,
    title: "Email the professor",
    next_action: "Write email to prof. Novák about the deadline",
    notes: null,
    type: "task",
    status: "next",
    context: "@pc",
    time_estimate_min: 10,
    energy: "low",
    steps_count: 1,
    suggested_priority: "medium",
    due_date: null,
    confidence: 0.9,
    ...overrides,
  };
}

export function makeDeps(provider: LlmProvider, telegram = new FakeTelegram()): Deps & { telegram: FakeTelegram } {
  return { db: env.DB, telegram, llm: () => provider };
}

let updateSeq = 1;
export function textUpdate(text: string, chatId = ALLOWED_CHAT): TgUpdate {
  const id = updateSeq++;
  return { update_id: id, message: { message_id: id, date: 0, chat: { id: chatId }, text } };
}

export function voiceUpdate(chatId = ALLOWED_CHAT): TgUpdate {
  const id = updateSeq++;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: chatId },
      voice: { file_id: `voice-${id}`, duration: 7, mime_type: "audio/ogg" },
    },
  };
}

export function callbackUpdate(data: string, messageId = 1000, chatId = ALLOWED_CHAT): TgUpdate {
  const id = updateSeq++;
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      from: { id: chatId },
      data,
      message: { message_id: messageId, date: 0, chat: { id: chatId } },
    },
  };
}
