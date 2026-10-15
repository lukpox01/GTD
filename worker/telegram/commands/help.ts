import type { Command } from "./types";

export const help: Command = {
  name: "help",
  description: "Show this help",
  async run({ deps, chatId, commands }) {
    const lines = [
      "Send me any thought as text or a voice message (Slovak or English) and I'll file it.",
      "",
      ...commands.map((c) => `/${c.name} — ${c.description}`),
    ];
    await deps.telegram.sendMessage(chatId, lines.join("\n"));
  },
};
