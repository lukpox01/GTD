import { listQuickNextActions } from "../../db/items";
import { formatItemList } from "../format";
import type { Command } from "./types";

const MAX_MINUTES = 15;

export const quick: Command = {
  name: "quick",
  description: `Next actions that take ≤${MAX_MINUTES} min`,
  async run({ deps, chatId }) {
    const items = await listQuickNextActions(deps.db, MAX_MINUTES);
    await deps.telegram.sendMessage(
      chatId,
      formatItemList(`⚡ Quick wins (≤${MAX_MINUTES} min)`, items, `No next actions under ${MAX_MINUTES} min.`),
    );
  },
};
