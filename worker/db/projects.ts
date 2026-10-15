export const PROJECT_STATUSES = ["active", "someday", "done", "dropped"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project {
  id: number;
  name: string;
  outcome: string | null;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithCounts extends Project {
  /** Linked items that are not done or deleted. */
  open_items: number;
  /** Linked items with status 'next'. A project with none is stalled. */
  next_actions: number;
}

export async function listProjects(db: D1Database): Promise<ProjectWithCounts[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*,
         COUNT(i.id) FILTER (WHERE i.status NOT IN ('done', 'deleted')) AS open_items,
         COUNT(i.id) FILTER (WHERE i.status = 'next') AS next_actions
       FROM projects p LEFT JOIN items i ON i.project_id = p.id
       GROUP BY p.id
       ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'someday' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                p.name COLLATE NOCASE`,
    )
    .all<ProjectWithCounts>();
  return results;
}

/** Active projects for the classifier prompt, at most `limit` (most recently touched first). */
export async function listActiveProjects(
  db: D1Database,
  limit = 100,
): Promise<Array<{ id: number; name: string; outcome: string | null }>> {
  const { results } = await db
    .prepare(`SELECT id, name, outcome FROM projects WHERE status = 'active' ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all<{ id: number; name: string; outcome: string | null }>();
  return results;
}

export async function projectName(db: D1Database, id: number | null): Promise<string | null> {
  if (id === null) return null;
  const row = await db.prepare(`SELECT name FROM projects WHERE id = ?`).bind(id).first<{ name: string }>();
  return row?.name ?? null;
}

export async function getProject(db: D1Database, id: number): Promise<Project | null> {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<Project>();
}

export async function createProject(db: D1Database, p: { name: string; outcome?: string | null }): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO projects (name, outcome) VALUES (?, ?) RETURNING id`)
    .bind(p.name, p.outcome ?? null)
    .first<{ id: number }>();
  if (!row) throw new Error("project insert returned no id");
  return row.id;
}

export interface ProjectPatch {
  name?: string;
  outcome?: string | null;
  status?: ProjectStatus;
}

/** Returns false if the project doesn't exist. */
export async function updateProject(db: D1Database, id: number, patch: ProjectPatch): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of ["name", "outcome", "status"] as const) {
    if (patch[col] === undefined) continue;
    sets.push(`${col} = ?`);
    binds.push(patch[col]);
  }
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
  const res = await db
    .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  return res.meta.changes > 0;
}

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
