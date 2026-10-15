<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Counts, type Item, type ItemView, type ProjectWithCounts } from "./lib/api";
  import Capture from "./components/Capture.svelte";
  import ItemCard from "./components/ItemCard.svelte";
  import Projects from "./components/Projects.svelte";
  import Sidebar from "./components/Sidebar.svelte";

  type Route = { kind: "view"; view: ItemView } | { kind: "projects" } | { kind: "project"; id: number };

  const VIEW_TITLES: Record<ItemView, string> = {
    inbox: "Inbox",
    next: "Next actions",
    waiting: "Waiting for",
    scheduled: "Scheduled",
    someday: "Someday / maybe",
    done: "Done",
    deleted: "Trash",
    all: "Everything",
  };
  const EMPTY: Record<ItemView, string> = {
    inbox: "Inbox zero. Send the bot a note to capture something.",
    next: "No next actions.",
    waiting: "Nothing you're waiting on.",
    scheduled: "Nothing scheduled.",
    someday: "No someday items.",
    done: "Nothing done yet.",
    deleted: "Trash is empty.",
    all: "No items yet.",
  };

  function parseRoute(hash: string): Route {
    const [, a, b] = hash.split("/");
    if (a === "projects") return { kind: "projects" };
    if (a === "project" && Number(b) > 0) return { kind: "project", id: Number(b) };
    if (a && a in VIEW_TITLES) return { kind: "view", view: a as ItemView };
    return { kind: "view", view: "inbox" };
  }

  let route = $state<Route>(parseRoute(location.hash));
  let items = $state<Item[]>([]);
  let counts = $state<Counts | null>(null);
  let projects = $state<ProjectWithCounts[]>([]);
  let contexts = $state<string[]>([]);
  let context = $state("");
  let q = $state("");
  let openId = $state<number | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let navOpen = $state(false);

  const project = $derived.by(() => {
    const r = route;
    return r.kind === "project" ? projects.find((p) => p.id === r.id) : undefined;
  });
  const title = $derived(
    route.kind === "view" ? VIEW_TITLES[route.view] : route.kind === "projects" ? "Projects" : (project?.name ?? "Project"),
  );
  const totalMinutes = $derived(items.reduce((sum, i) => sum + (i.time_estimate_min ?? 0), 0));

  let loadSeq = 0;
  async function loadItems() {
    if (route.kind === "projects") return;
    const seq = ++loadSeq;
    loading = true;
    try {
      const filter =
        route.kind === "project"
          ? { view: "all" as const, project_id: route.id, context, q }
          : { view: route.view, context, q };
      const result = await api.items(filter);
      if (seq === loadSeq) items = result;
    } catch (e) {
      if (seq === loadSeq) error = (e as Error).message;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  async function loadMeta() {
    try {
      [counts, projects, contexts] = await Promise.all([api.counts(), api.projects(), api.contexts()]);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function refresh() {
    void loadItems();
    void loadMeta();
  }

  /** An item changed: update it in place, and drop it if it no longer belongs in this view. */
  function onChanged(item: Item) {
    const belongs =
      route.kind === "project"
        ? item.project_id === route.id
        : route.kind === "view" &&
          (route.view === "all"
            ? item.status !== "deleted"
            : route.view === "inbox"
              ? (item.reviewed_at === null || item.status === "inbox") && item.status !== "done" && item.status !== "deleted"
              : item.status === route.view);
    items = belongs ? items.map((i) => (i.id === item.id ? item : i)) : items.filter((i) => i.id !== item.id);
    if (!belongs && openId === item.id) openId = null;
    void loadMeta();
  }

  function onCaptured(item: Item) {
    if (route.kind === "view" && (route.view === "inbox" || route.view === "all")) items = [...items, item];
    void loadMeta();
  }

  onMount(() => {
    const onHash = () => {
      route = parseRoute(location.hash);
      openId = null;
      navOpen = false;
    };
    window.addEventListener("hashchange", onHash);
    // Pick up notes captured from Telegram while the tab sat in the background.
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  // Reload when the route or filters change (search is debounced).
  let debounce: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void route;
    void context;
    const query = q;
    clearTimeout(debounce);
    debounce = setTimeout(loadItems, query ? 250 : 0);
  });
  onMount(loadMeta);
</script>

<div class="layout" class:nav-open={navOpen}>
  <Sidebar {route} {counts} {projects} />

  <main>
    <header>
      <button class="ghost menu" aria-label="Menu" onclick={() => (navOpen = !navOpen)}>☰</button>
      <div class="heading">
        <h1>{title}</h1>
        {#if route.kind === "project" && project?.outcome}
          <p class="muted outcome">{project.outcome}</p>
        {/if}
      </div>
      {#if route.kind !== "projects" && items.length > 0}
        <span class="muted summary">
          {items.length} item{items.length === 1 ? "" : "s"}{#if totalMinutes > 0}&nbsp;· ~{Math.round(totalMinutes / 6) / 10} h{/if}
        </span>
      {/if}
    </header>

    {#if error}
      <div class="error" role="alert">
        {error}
        <button class="ghost" onclick={() => (error = null)} aria-label="Dismiss">✕</button>
      </div>
    {/if}

    {#if route.kind === "projects"}
      <Projects {projects} onChange={loadMeta} onError={(m) => (error = m)} />
    {:else}
      {#if route.kind === "view" && route.view === "inbox"}
        <Capture onCaptured={onCaptured} onError={(m) => (error = m)} />
        {#if counts && counts.needs_review > 0}
          <p class="hint">⚠️ {counts.needs_review} note{counts.needs_review === 1 ? "" : "s"} couldn't be sorted by the AI. Open them to fix by hand or retry.</p>
        {/if}
      {/if}

      <div class="filters">
        <input type="search" placeholder="Search" bind:value={q} aria-label="Search" />
        {#if contexts.length > 0}
          <select bind:value={context} aria-label="Context">
            <option value="">All contexts</option>
            {#each contexts as c (c)}<option value={c}>{c}</option>{/each}
          </select>
        {/if}
        <button class="ghost" onclick={refresh} aria-label="Refresh" title="Refresh">↻</button>
      </div>

      <ul class="items" aria-busy={loading}>
        {#each items as item (item.id)}
          <ItemCard
            {item}
            {projects}
            {contexts}
            inbox={route.kind === "view" && route.view === "inbox"}
            open={openId === item.id}
            onToggle={() => (openId = openId === item.id ? null : item.id)}
            {onChanged}
            onError={(m) => (error = m)}
            onProjectsChanged={loadMeta}
          />
        {:else}
          {#if !loading}
            <li class="empty muted">
              {q || context ? "Nothing matches." : route.kind === "view" ? EMPTY[route.view] : "No items in this project yet."}
            </li>
          {/if}
        {/each}
      </ul>
    {/if}
  </main>
  <button class="scrim" aria-label="Close menu" onclick={() => (navOpen = false)}></button>
</div>

<style>
  .layout { display: grid; grid-template-columns: 15rem 1fr; min-height: 100vh; }
  main { padding: 1.25rem 1.5rem 4rem; max-width: 52rem; width: 100%; }
  header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
  .heading { flex: 1; min-width: 0; }
  h1 { font-size: 1.4rem; margin: 0; }
  .outcome { margin: 0.15rem 0 0; }
  .summary { font-size: 0.85rem; }
  .menu { display: none; font-size: 1.2rem; }
  .filters { display: flex; gap: 0.5rem; margin: 0.75rem 0; }
  .filters select { width: auto; flex: none; max-width: 40%; }
  .items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .items[aria-busy="true"] { opacity: 0.6; }
  .empty { padding: 2.5rem 1rem; text-align: center; }
  .hint { background: var(--warn-soft); color: var(--warn); padding: 0.5rem 0.75rem; border-radius: var(--radius); margin: 0.5rem 0; font-size: 0.9rem; }
  .error {
    display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
    background: var(--danger-soft); color: var(--danger); padding: 0.5rem 0.75rem; border-radius: var(--radius); margin-bottom: 0.75rem;
  }
  .scrim { display: none; }

  @media (max-width: 760px) {
    .layout { grid-template-columns: 1fr; }
    main { padding: 0.75rem 1rem 4rem; }
    .menu { display: inline-block; }
    .layout :global(nav) {
      position: fixed; inset: 0 auto 0 0; width: 16rem; z-index: 20;
      transform: translateX(-100%); transition: transform 0.15s ease;
    }
    .nav-open :global(nav) { transform: none; }
    .nav-open .scrim {
      display: block; position: fixed; inset: 0; z-index: 10; border: 0; border-radius: 0; background: rgb(0 0 0 / 0.35);
    }
  }
</style>
