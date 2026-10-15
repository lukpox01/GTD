<script lang="ts">
  import { api, type Item } from "../lib/api";

  let { onCaptured, onError }: { onCaptured: (item: Item) => void; onError: (msg: string) => void } = $props();
  let text = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const note = text.trim();
    if (!note || busy) return;
    busy = true;
    try {
      onCaptured(await api.capture(note));
      text = "";
    } catch (err) {
      onError((err as Error).message);
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={submit}>
  <label class="sr-only" for="capture">Capture a note</label>
  <input id="capture" placeholder="Capture a thought… (AI sorts it, like the bot)" bind:value={text} disabled={busy} autocomplete="off" />
  <button class="primary" disabled={busy || !text.trim()}>{busy ? "Sorting…" : "Add"}</button>
</form>

<style>
  form { display: flex; gap: 0.5rem; }
  input { padding: 0.55rem 0.75rem; }
</style>
