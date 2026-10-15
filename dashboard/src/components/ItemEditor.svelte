<script lang="ts">
  import { api, type Item, type ItemPatch, type ProjectWithCounts } from "../lib/api";
  import { ago } from "../lib/format";

  let {
    item,
    projects,
    contexts,
    onChanged,
    onError,
    onProjectsChanged,
  }: {
    item: Item;
    projects: ProjectWithCounts[];
    contexts: string[];
    onChanged: (item: Item) => void;
    onError: (msg: string) => void;
    onProjectsChanged: () => void;
  } = $props();

  const STATUSES = ["inbox", "next", "waiting", "scheduled", "someday", "done"] as const;
  const TYPES = ["task", "project", "idea", "reference", "someday"] as const;
  const LEVELS = ["high", "medium", "low"] as const;
  const NEW_PROJECT = -1;

  type Draft = {
    title: string; next_action: string; notes: string; type: string; status: string; project_id: number | null;
    context: string; time_estimate_min: string; energy: string; priority: string; due_date: string;
  };
  const toDraft = (i: Item): Draft => ({
    title: i.title ?? "",
    next_action: i.next_action ?? "",
    notes: i.notes ?? "",
    type: i.type ?? "",
    status: i.status === "deleted" ? "inbox" : i.status,
    project_id: i.project_id,
    context: i.context ?? "",
    time_estimate_min: i.time_estimate_min === null ? "" : String(i.time_estimate_min),
    energy: i.energy ?? "",
    priority: i.priority ?? "",
    due_date: i.due_date ?? "",
  });

  // svelte-ignore state_referenced_locally -- the draft starts from the item and is reset after each save
  let draft = $state<Draft>(toDraft(item));
  let busy = $state(false);
  let showLog = $state(false);

  function patch(): ItemPatch {
    const orig = toDraft(item);
    const p: ItemPatch = {};
    const text = (k: "title" | "next_action" | "notes" | "context") => {
      if (draft[k] !== orig[k]) p[k] = draft[k].trim() || null;
    };
    text("title");
    text("next_action");
    text("notes");
    text("context");
    if (draft.type !== orig.type) p.type = (draft.type || null) as ItemPatch["type"];
    if (draft.status !== orig.status || item.status === "deleted") p.status = draft.status as ItemPatch["status"];
    if (draft.project_id !== orig.project_id) p.project_id = draft.project_id;
    if (draft.time_estimate_min !== orig.time_estimate_min) {
      p.time_estimate_min = draft.time_estimate_min === "" ? null : Math.max(0, Math.round(Number(draft.time_estimate_min)));
    }
    if (draft.energy !== orig.energy) p.energy = (draft.energy || null) as ItemPatch["energy"];
    if (draft.priority !== orig.priority) p.priority = (draft.priority || null) as ItemPatch["priority"];
    if (draft.due_date !== orig.due_date) p.due_date = draft.due_date || null;
    return p;
  }
  const dirty = $derived(Object.keys(patch()).length > 0);

  async function run(action: () => Promise<Item>) {
    busy = true;
    try {
      const updated = await action();
      draft = toDraft(updated);
      onChanged(updated);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      busy = false;
    }
  }

  const save = (approve: boolean) => run(() => api.update(item.id, { ...patch(), ...(approve ? { reviewed: true } : {}) }));

  async function onProjectSelect(e: Event) {
    const value = Number((e.currentTarget as HTMLSelectElement).value);
    if (value !== NEW_PROJECT) {
      draft.project_id = value || null;
      return;
    }
    const name = prompt("New project name", draft.title || item.title || "")?.trim();
    if (!name) {
      (e.currentTarget as HTMLSelectElement).value = String(draft.project_id ?? 0);
      return;
    }
    try {
      const created = await api.createProject(name, null);
      onProjectsChanged();
      draft.project_id = created.id;
      if (!draft.type || draft.type === "task") draft.type = "project";
    } catch (err) {
      onError((err as Error).message);
    }
  }

  function reclassify() {
    if (!item.needs_review && !confirm("Re-run the AI on the original note? It overwrites the title, status and other AI fields.")) return;
    void run(() => api.reclassify(item.id));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty) void save(false);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="editor" onkeydown={onKey}>
  {#if item.raw_text || item.transcript}
    <blockquote>
      {#if item.source === "voice"}<span class="muted">🎙 Transcript · </span>{/if}{item.transcript ?? item.raw_text}
    </blockquote>
  {/if}

  <div class="grid">
    <label class="wide">Title <input bind:value={draft.title} /></label>
    <label class="wide">Next action <input bind:value={draft.next_action} placeholder="The very next physical step" /></label>
    <label>
      Status
      <select bind:value={draft.status}>
        {#each STATUSES as s (s)}<option value={s}>{s}</option>{/each}
      </select>
    </label>
    <label>
      Type
      <select bind:value={draft.type}>
        <option value="">—</option>
        {#each TYPES as t (t)}<option value={t}>{t}</option>{/each}
      </select>
    </label>
    <label>
      Priority
      <select bind:value={draft.priority}>
        <option value="">— {item.suggested_priority ? `(AI suggests ${item.suggested_priority})` : ""}</option>
        {#each LEVELS as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </label>
    <label>
      Due date
      <input type="date" bind:value={draft.due_date} />
    </label>
    <label>
      Context
      <input bind:value={draft.context} list="contexts-{item.id}" placeholder="@pc" />
      <datalist id="contexts-{item.id}">
        {#each contexts as c (c)}<option value={c}></option>{/each}
      </datalist>
    </label>
    <label>
      Time (min)
      <input type="number" min="0" step="5" bind:value={draft.time_estimate_min} />
    </label>
    <label>
      Energy
      <select bind:value={draft.energy}>
        <option value="">—</option>
        {#each LEVELS as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </label>
    <label>
      Project
      <select value={String(draft.project_id ?? 0)} onchange={onProjectSelect}>
        <option value="0">—</option>
        {#each projects.filter((p) => p.status === "active" || p.id === draft.project_id) as p (p.id)}
          <option value={String(p.id)}>{p.name}</option>
        {/each}
        <option value={String(NEW_PROJECT)}>+ New project…</option>
      </select>
    </label>
    <label class="wide">Notes <textarea rows="3" bind:value={draft.notes}></textarea></label>
  </div>

  <div class="actions">
    {#if (item.reviewed_at === null || item.status === "inbox") && item.status !== "deleted"}
      <button
        class="primary"
        disabled={busy || draft.status === "inbox"}
        title={draft.status === "inbox" ? "Pick a status first, so it lands in a list" : undefined}
        onclick={() => save(true)}>{dirty ? "Save & approve" : "Approve"}</button>
      <button disabled={busy || !dirty} onclick={() => save(false)}>Save</button>
      {#if draft.status === "inbox"}<span class="muted hint">Pick a status to approve</span>{/if}
    {:else}
      <button class="primary" disabled={busy || !dirty} onclick={() => save(false)}>Save</button>
    {/if}
    {#if dirty}<button class="ghost" disabled={busy} onclick={() => (draft = toDraft(item))}>Reset</button>{/if}
    <span class="spacer"></span>
    {#if item.raw_text || item.telegram_file_id}
      <button class="ghost" disabled={busy} onclick={reclassify} title="Run the AI again on the original note">
        {item.needs_review ? "↻ Retry AI" : "↻ Re-sort with AI"}
      </button>
    {/if}
    {#if item.status === "deleted"}
      <button disabled={busy} onclick={() => run(() => api.update(item.id, { status: draft.status as ItemPatch["status"] }))}>Restore</button>
    {:else}
      <button class="ghost danger" disabled={busy} onclick={() => run(() => api.remove(item.id))}>Delete</button>
    {/if}
  </div>

  <div class="meta muted">
    #{item.id} · captured {ago(item.created_at)} via {item.source === "voice" ? "voice" : item.telegram_chat_id ? "Telegram" : "dashboard"}
    {#if item.ai_model}· {item.ai_model}{#if item.ai_confidence !== null} ({Math.round(item.ai_confidence * 100)}% sure){/if}{/if}
    {#if item.language}· {item.language}{/if}
    {#if item.reviewed_at}· reviewed {ago(item.reviewed_at)}{/if}
    {#if item.pipeline_log.length}
      · <button class="link" onclick={() => (showLog = !showLog)}>{showLog ? "hide" : "show"} log</button>
    {/if}
  </div>
  {#if showLog}
    <ol class="log">
      {#each item.pipeline_log as entry, i (i)}
        <li class:err={entry.error}>
          <strong>{entry.step}</strong> <span class="muted">{entry.at.replace("T", " ").slice(0, 19)}</span>
          {#if entry.detail}<div>{entry.detail}</div>{/if}
          {#if entry.error}<div>{entry.error}</div>{/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .editor { border-top: 1px solid var(--border); padding: 0.75rem 0.75rem 0.65rem; display: flex; flex-direction: column; gap: 0.75rem; }
  blockquote {
    margin: 0; padding: 0.5rem 0.75rem; background: var(--surface-2); border-radius: 8px;
    white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.92rem;
  }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.6rem 0.75rem; }
  label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--muted); }
  label :global(input), label :global(select), label :global(textarea) { color: var(--text); font-size: 0.95rem; }
  .wide { grid-column: 1 / -1; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .spacer { flex: 1; }
  .hint { font-size: 0.8rem; }
  .meta { font-size: 0.8rem; }
  .link { border: 0; background: none; padding: 0; color: var(--accent); font-size: inherit; }
  .log { margin: 0; padding-left: 1.25rem; font-size: 0.8rem; display: flex; flex-direction: column; gap: 0.25rem; overflow-wrap: anywhere; }
  .log .err { color: var(--danger); }
  @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
