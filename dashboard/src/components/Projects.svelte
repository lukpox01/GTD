<script lang="ts">
  import { api, type ProjectWithCounts } from "../lib/api";

  let { projects, onChange, onError }: { projects: ProjectWithCounts[]; onChange: () => void; onError: (m: string) => void } =
    $props();

  const STATUSES = ["active", "someday", "done", "dropped"] as const;
  let name = $state("");
  let outcome = $state("");
  let busy = $state(false);

  async function act(fn: () => Promise<unknown>) {
    busy = true;
    try {
      await fn();
      onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      busy = false;
    }
  }

  function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    void act(async () => {
      await api.createProject(name.trim(), outcome.trim() || null);
      name = "";
      outcome = "";
    });
  }

  function rename(p: ProjectWithCounts) {
    const next = prompt("Project name", p.name)?.trim();
    if (next && next !== p.name) void act(() => api.updateProject(p.id, { name: next }));
  }

  function editOutcome(p: ProjectWithCounts) {
    const next = prompt("Desired outcome (what does done look like?)", p.outcome ?? "");
    if (next !== null && next.trim() !== (p.outcome ?? "")) void act(() => api.updateProject(p.id, { outcome: next.trim() || null }));
  }
</script>

<form onsubmit={create}>
  <input placeholder="New project name" bind:value={name} aria-label="New project name" />
  <input placeholder="Outcome (optional)" bind:value={outcome} aria-label="Outcome" />
  <button class="primary" disabled={busy || !name.trim()}>Add</button>
</form>

<ul>
  {#each projects as p (p.id)}
    <li class:inactive={p.status !== "active"}>
      <div class="info">
        <a href="#/project/{p.id}" class="name">{p.name}</a>
        <button class="link muted" onclick={() => editOutcome(p)}>{p.outcome ?? "+ add outcome"}</button>
        <div class="chips">
          <span class="chip">{p.open_items} open</span>
          {#if p.status === "active" && p.next_actions === 0}
            <span class="chip warn" title="An active project needs at least one next action">no next action</span>
          {:else if p.next_actions > 0}
            <span class="chip ok">{p.next_actions} next</span>
          {/if}
        </div>
      </div>
      <div class="controls">
        <button class="ghost" disabled={busy} onclick={() => rename(p)} aria-label="Rename {p.name}">✎</button>
        <select
          value={p.status}
          disabled={busy}
          aria-label="Status of {p.name}"
          onchange={(e) => act(() => api.updateProject(p.id, { status: (e.currentTarget as HTMLSelectElement).value as (typeof STATUSES)[number] }))}
        >
          {#each STATUSES as s (s)}<option value={s}>{s}</option>{/each}
        </select>
      </div>
    </li>
  {:else}
    <li class="empty muted">No projects yet. Add one above, or tap “Is project” on a note in Telegram.</li>
  {/each}
</ul>

<style>
  form { display: grid; grid-template-columns: 1fr 1.4fr auto; gap: 0.5rem; margin-bottom: 1rem; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  li {
    display: flex; gap: 0.75rem; align-items: flex-start; justify-content: space-between;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.6rem 0.75rem;
    box-shadow: var(--shadow);
  }
  li.inactive { opacity: 0.65; }
  .info { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; align-items: flex-start; }
  .name { font-weight: 600; color: inherit; overflow-wrap: anywhere; }
  .link { border: 0; background: none; padding: 0; text-align: left; white-space: normal; font-size: 0.88rem; }
  .chips { display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .controls { display: flex; gap: 0.25rem; align-items: center; flex: none; }
  .controls select { width: auto; }
  .empty { justify-content: center; padding: 2rem 1rem; border-style: dashed; box-shadow: none; }
  @media (max-width: 760px) { form { grid-template-columns: 1fr; } li { flex-direction: column; } }
</style>
