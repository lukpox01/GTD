import { getItem, setStatusReviewed, type ItemStatus } from "../db/items";
import { convertItemToProject, projectName } from "../db/projects";
import type { Deps } from "../deps";
import { formatItemMessage, itemKeyboard, parseCallbackData, type CallbackAction } from "./format";
import type { TgCallbackQuery } from "./types";

const STATUS_FOR: Partial<Record<CallbackAction, ItemStatus>> = {
  done: "done",
  someday: "someday",
  delete: "deleted", // soft delete; restorable from the dashboard
};

const TOAST: Record<CallbackAction, string> = {
  done: "Marked done ✅",
  someday: "Moved to someday 🌙",
  delete: "Deleted 🗑",
  project: "Turned into a project 🗂",
};

export async function handleCallback(deps: Deps, query: TgCallbackQuery): Promise<void> {
  const parsed = parseCallbackData(query.data);
  if (!parsed) {
    await deps.telegram.answerCallbackQuery(query.id, "Unknown action");
    return;
  }
  const { action, itemId } = parsed;

  // Check first: convertItemToProject throws on a missing item, which would leave the button spinning.
  if (!(await getItem(deps.db, itemId))) {
    await deps.telegram.answerCallbackQuery(query.id, `Item #${itemId} not found`);
    return;
  }

  const status = STATUS_FOR[action];
  if (status) await setStatusReviewed(deps.db, itemId, status);
  else if (action === "project") await convertItemToProject(deps.db, itemId);

  const item = await getItem(deps.db, itemId);
  if (!item) return;
  await deps.telegram.answerCallbackQuery(query.id, TOAST[action]);
  if (query.message) {
    await deps.telegram.editMessageText(
      query.message.chat.id,
      query.message.message_id,
      formatItemMessage(item, await projectName(deps.db, item.project_id)),
      itemKeyboard(itemId),
    );
  }
}
