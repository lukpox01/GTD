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
    project_id: null,
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

/** An RSA key pair standing in for a Cloudflare Access team's signing key. */
export async function makeAccessKey(kid = "test-kid") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid };
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

  async function sign(payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
    const signingInput = `${enc({ alg: "RS256", kid, typ: "JWT", ...header })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signingInput));
    return `${signingInput}.${b64url(new Uint8Array(sig))}`;
  }
  return { jwk, sign };
}
