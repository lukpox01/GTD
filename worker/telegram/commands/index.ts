import type { Deps } from "../../deps";
import { help } from "./help";
import { inbox } from "./inbox";
import { quick } from "./quick";
import type { Command } from "./types";

export type { Command, CommandContext } from "./types";

/** To add a command: create a module exporting a Command and list it here. /help picks it up. */
export const COMMANDS: readonly Command[] = [inbox, quick, help];

const ALIASES: Record<string, string> = { start: "help" };

/** "/inbox@MyBot  foo" → { name: "inbox", args: "foo" }; null if not a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m?.[1]) return null;
  const name = m[1].toLowerCase();
  return { name: ALIASES[name] ?? name, args: (m[2] ?? "").trim() };
}

export async function runCommand(deps: Deps, chatId: number, text: string): Promise<boolean> {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  const command = COMMANDS.find((c) => c.name === parsed.name);
  if (!command) {
    await deps.telegram.sendMessage(chatId, `Unknown command /${parsed.name}. Try /help.`);
    return true;
  }
  await command.run({ deps, chatId, args: parsed.args, commands: COMMANDS });
  return true;
}
