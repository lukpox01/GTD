<script lang="ts">
  import { api, type Item, type ProjectWithCounts } from "../lib/api";
  import { TYPE_ICON, displayTitle, minutes, relativeDue } from "../lib/format";
  import ItemEditor from "./ItemEditor.svelte";

  let {
    item,
    projects,
    contexts,
    inbox,
    open,
    onToggle,
    onChanged,
    onError,
    onProjectsChanged,
  }: {
    item: Item;
    projects: ProjectWithCounts[];
    contexts: string[];
    inbox: boolean;
    open: boolean;
    onToggle: () => void;
    onChanged: (item: Item) => void;
    onError: (msg: string) => void;
    onProjectsChanged: () => void;
  } = $props();

  let busy = $state(false);
  const project = $derived(projects.find((p) => p.id === item.project_id));
  const due = $derived(item.due_date ? relativeDue(item.due_date) : null);

  async function run(action: () => Promise<Item>) {
    busy = true;
    try {
      onChanged(await action());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      busy = false;
    }
  }

  const toggleDone = () =>
    run(() => api.update(item.id, { status: item.status === "done" ? "next" : "done" }));
</script>

<li class="card" class:open class:done={item.status === "done"} class:deleted={item.status === "deleted"}>
  <div class="row">
    <input
      type="checkbox"
      class="check"
      checked={item.status === "done"}
      disabled={busy || item.status === "deleted"}
      onchange={toggleDone}
      aria-label={item.status === "done" ? "Mark not done" : "Mark done"}
    />
    <button class="main ghost" onclick={onToggle} aria-expanded={open}>
      <span class="title">
        <span aria-hidden="true">{item.type ? TYPE_ICON[item.type] : "📥"}</span>
        {displayTitle(item)}
      </span>
      {#if item.next_action && item.next_action !== item.title}
        <span class="next muted">➡️ {item.next_action}</span>
      {/if}
      <span class="chips">
        {#if item.needs_review}<span class="chip danger">⚠️ AI failed</span>{/if}
        {#if item.priority}<span class="chip" class:danger={item.priority === "high"} class:accent={item.priority === "medium"}>{item.priority}</span>{/if}
        {#if due}<span class="chip" class:danger={due.overdue} class:warn={due.soon}>📅 {due.label}</span>{/if}
        {#if item.context}<span class="chip">{item.context}</span>{/if}
        {#if item.time_estimate_min !== null}<span class="chip">⏱ {minutes(item.time_estimate_min)}</span>{/if}
        {#if item.energy}<span class="chip">⚡ {item.energy}</span>{/if}
        {#if project}<span class="chip accent">🗂 {project.name}</span>{/if}
        {#if inbox && item.status !== "inbox"}<span class="chip ok">→ {item.status}</span>{/if}
        {#if item.source === "voice"}<span class="chip" title="Voice note">🎙</span>{/if}
      </span>
    </button>
    {#if inbox && !open}
      <button class="approve" disabled={busy} onclick={() => run(() => api.update(item.id, { reviewed: true }))} title="Keep the AI's sorting and take it out of the inbox">
        ✓ Approve
      </button>
    {/if}
  </div>

  {#if open}
    <ItemEditor {item} {projects} {contexts} {onChanged} {onError} {onProjectsChanged} />
  {/if}
</li>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
  .card.open { border-color: var(--accent); }
  .row { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.55rem 0.65rem; }
  .check { width: 1.15rem; height: 1.15rem; margin: 0.2rem 0 0; flex: none; accent-color: var(--accent); cursor: pointer; }
  .main {
    flex: 1; min-width: 0; text-align: left; padding: 0; display: flex; flex-direction: column; gap: 0.2rem;
    white-space: normal; border: 0;
  }
  .main:hover { background: none !important; }
  .title { font-weight: 550; overflow-wrap: anywhere; }
  .done .title { text-decoration: line-through; color: var(--muted); }
  .deleted .title { color: var(--muted); }
  .next { font-size: 0.88rem; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .chips:empty { display: none; }
  .approve { flex: none; font-size: 0.85rem; color: var(--ok); }
</style>
