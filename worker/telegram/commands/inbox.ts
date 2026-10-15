import { listUnreviewed } from "../../db/items";
import { formatItemList } from "../format";
import type { Command } from "./types";

export const inbox: Command = {
  name: "inbox",
  description: "Items you haven't reviewed yet",
  async run({ deps, chatId }) {
    const items = await listUnreviewed(deps.db);
    await deps.telegram.sendMessage(chatId, formatItemList("📥 Inbox (unreviewed)", items, "📥 Inbox zero 🎉"));
  },
};
