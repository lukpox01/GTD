<script lang="ts">
  import type { Counts, ItemView, ProjectWithCounts } from "../lib/api";

  type Route = { kind: "view"; view: ItemView } | { kind: "projects" } | { kind: "project"; id: number };
  let { route, counts, projects }: { route: Route; counts: Counts | null; projects: ProjectWithCounts[] } = $props();

  const LISTS: Array<{ view: ItemView; label: string; icon: string }> = [
    { view: "inbox", label: "Inbox", icon: "📥" },
    { view: "next", label: "Next actions", icon: "➡️" },
    { view: "waiting", label: "Waiting for", icon: "⏳" },
    { view: "scheduled", label: "Scheduled", icon: "📅" },
    { view: "someday", label: "Someday / maybe", icon: "🌙" },
  ];
  const ARCHIVE: Array<{ view: ItemView; label: string; icon: string }> = [
    { view: "all", label: "Everything", icon: "🗃" },
    { view: "done", label: "Done", icon: "✅" },
    { view: "deleted", label: "Trash", icon: "🗑" },
  ];

  const active = $derived(projects.filter((p) => p.status === "active"));
  const isView = (v: ItemView) => route.kind === "view" && route.view === v;
</script>

<nav>
  <div class="brand">GTD Inbox</div>
  <ul>
    {#each LISTS as l (l.view)}
      <li>
        <a href="#/{l.view}" class:current={isView(l.view)} aria-current={isView(l.view) ? "page" : undefined}>
          <span aria-hidden="true">{l.icon}</span>
          <span class="label">{l.label}</span>
          {#if counts && counts[l.view] > 0}<span class="count" class:hot={l.view === "inbox"}>{counts[l.view]}</span>{/if}
        </a>
      </li>
    {/each}
  </ul>

  <a class="section" href="#/projects" class:current={route.kind === "projects"}>Projects</a>
  <ul>
    {#each active as p (p.id)}
      <li>
        <a href="#/project/{p.id}" class:current={route.kind === "project" && route.id === p.id}>
          <span aria-hidden="true">🗂</span>
          <span class="label">{p.name}</span>
          {#if p.next_actions === 0}<span class="stalled" title="No next action">!</span>{/if}
        </a>
      </li>
    {:else}
      <li class="none muted">No active projects</li>
    {/each}
  </ul>

  <div class="section">Archive</div>
  <ul>
    {#each ARCHIVE as l (l.view)}
      <li>
        <a href="#/{l.view}" class:current={isView(l.view)}>
          <span aria-hidden="true">{l.icon}</span>
          <span class="label">{l.label}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  nav {
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 1rem 0.6rem;
    overflow-y: auto;
    height: 100vh;
    position: sticky;
    top: 0;
  }
  .brand { font-weight: 700; padding: 0.25rem 0.6rem 0.9rem; }
  ul { list-style: none; margin: 0 0 0.75rem; padding: 0; }
  a {
    display: flex; align-items: center; gap: 0.55rem;
    padding: 0.38rem 0.6rem; border-radius: 8px; color: inherit; text-decoration: none;
  }
  a:hover { background: var(--surface-2); }
  a.current { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { font-size: 0.8rem; color: var(--muted); }
  .count.hot { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 0.45rem; font-weight: 600; }
  .stalled { color: var(--warn); font-weight: 700; }
  .section {
    display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); padding: 0.5rem 0.6rem 0.25rem; font-weight: 600;
  }
  a.section.current { background: none; color: var(--accent); }
  .none { font-size: 0.85rem; padding: 0.2rem 0.6rem; }
</style>
