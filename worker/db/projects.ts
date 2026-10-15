/**
 * Turn an item into a project: create a project named after it and link the item.
 * Idempotent — if the item is already linked to a project, that project is reused.
 * Returns the project id.
 */
export async function convertItemToProject(db: D1Database, itemId: number): Promise<number> {
  const item = await db
    .prepare(`SELECT title, raw_text, transcript, project_id FROM items WHERE id = ?`)
    .bind(itemId)
    .first<{ title: string | null; raw_text: string | null; transcript: string | null; project_id: number | null }>();
  if (!item) throw new Error(`item ${itemId} not found`);

  let projectId = item.project_id;
  if (projectId === null) {
    const name = item.title ?? (item.raw_text ?? item.transcript ?? `Item #${itemId}`).slice(0, 80);
    const row = await db
      .prepare(`INSERT INTO projects (name) VALUES (?) RETURNING id`)
      .bind(name)
      .first<{ id: number }>();
    if (!row) throw new Error("project insert returned no id");
    projectId = row.id;
  }

  await db
    .prepare(
      `UPDATE items SET type = 'project', project_id = ?,
         status = CASE WHEN status IN ('done', 'deleted', 'inbox') THEN 'next' ELSE status END,
         reviewed_at = COALESCE(reviewed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .bind(projectId, itemId)
    .run();
  return projectId;
}
