import type { Deps } from "../../deps";

export interface CommandContext {
  deps: Deps;
  chatId: number;
  /** Text after the command, trimmed. */
  args: string;
  /** The full registry, e.g. for /help. */
  commands: readonly Command[];
}

export interface Command {
  /** Without the leading slash. */
  name: string;
  description: string;
  run(ctx: CommandContext): Promise<void>;
}
