import type { Item, ItemPatch, ItemView } from "../../../worker/db/items";
import type { Project, ProjectPatch, ProjectWithCounts } from "../../../worker/db/projects";

export type { Item, ItemPatch, ItemView, Project, ProjectPatch, ProjectWithCounts };
export type Counts = Record<ItemView | "needs_review", number>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  // An expired Access session gets redirected to the login page, which fetch can't follow usefully.
  if (res.type === "opaqueredirect" || res.redirected) throw new ApiError("Session expired — reload the page", 401);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON (e.g. the Access login page)
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status === 401 ? "Session expired — reload the page" : msg, res.status);
  }
  return data as T;
}

export interface ItemFilter {
  view: ItemView;
  project_id?: number;
  context?: string;
  q?: string;
}

export const api = {
  items(f: ItemFilter) {
    const qs = new URLSearchParams({ view: f.view });
    if (f.project_id !== undefined) qs.set("project_id", String(f.project_id));
    if (f.context) qs.set("context", f.context);
    if (f.q) qs.set("q", f.q);
    return request<{ items: Item[] }>("GET", `/items?${qs}`).then((r) => r.items);
  },
  counts: () => request<Counts>("GET", "/counts"),
  contexts: () => request<{ contexts: string[] }>("GET", "/contexts").then((r) => r.contexts),
  me: () => request<{ email: string | null }>("GET", "/me"),
  capture: (text: string) => request<{ item: Item }>("POST", "/items", { text }).then((r) => r.item),
  update: (id: number, patch: ItemPatch) =>
    request<{ item: Item }>("PATCH", `/items/${id}`, patch).then((r) => r.item),
  remove: (id: number) => request<{ item: Item }>("DELETE", `/items/${id}`).then((r) => r.item),
  reclassify: (id: number) => request<{ item: Item }>("POST", `/items/${id}/reclassify`).then((r) => r.item),
  projects: () => request<{ projects: ProjectWithCounts[] }>("GET", "/projects").then((r) => r.projects),
  createProject: (name: string, outcome: string | null) =>
    request<{ project: Project }>("POST", "/projects", { name, outcome }).then((r) => r.project),
  updateProject: (id: number, patch: ProjectPatch) =>
    request<{ project: Project }>("PATCH", `/projects/${id}`, patch).then((r) => r.project),
};
