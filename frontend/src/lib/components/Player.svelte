<script lang="ts">
  import { tick } from 'svelte';
  import { engine, app } from '$lib/state.svelte';
  import { fmtTime } from '$lib/format';
  import { renameTrack } from '$lib/api';
  import StemControls from './StemControls.svelte';
  import DownloadDialog from './DownloadDialog.svelte';
  import PitchControl from './PitchControl.svelte';

  let downloadOpen = $state(false);

  type Props = { onSelectAnother: () => void };
  let { onSelectAnother }: Props = $props();

  const trackName = $derived(app.currentTrack?.name ?? '');
  const t = $derived(app.player.currentTime);
  const dur = $derived(app.player.duration);
  const playing = $derived(app.player.playing);
  const seekPct = $derived(dur ? (t / dur) * 100 : 0);

  function onSeek(ev: Event) {
    engine.seekTo(parseFloat((ev.target as HTMLInputElement).value));
  }

  // --- inline rename --------------------------------------------------------

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);

  async function startEdit() {
    if (!app.currentTrack || editing) return;
    draft = app.currentTrack.name;
    editing = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  function cancelEdit() {
    editing = false;
    draft = '';
  }

  async function commitEdit() {
    if (!editing || !app.currentTrack || saving) return;
    const normalized = draft.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      cancelEdit();
      return;
    }
    if (normalized === app.currentTrack.name) {
      editing = false;
      return;
    }
    saving = true;
    try {
      const { name } = await renameTrack(app.currentTrack.jobId, normalized);
      const jobId = app.currentTrack.jobId;
      app.currentTrack = { ...app.currentTrack, name };
      app.tracks = app.tracks.map((tr) => (tr.job_id === jobId ? { ...tr, name } : tr));
      editing = false;
    } catch {
      // keep editing mode so the user can retry; field stays focused
    } finally {
      saving = false;
    }
  }

  function onEditKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  function onTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      startEdit();
    }
  }

  // Mobile compact mode: hide stem controls + "select another song" by
  // default; show via the expand toggle. Always expanded on desktop.
  let expanded = $state(false);

  // share button: tries the native share sheet first (mobile), falls back
  // to copying the URL to the clipboard. `copied` flashes the icon for
  // ~1.5s so the user sees something happened.
  let copied = $state(false);
  async function share() {
    if (typeof window === 'undefined') return;
    const url = window.location.href;
    const title = app.currentTrack?.name ?? 'divide and cover';
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // user cancelled the share sheet or it isn't available — fall through
        // to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked — nothing we can do gracefully */
    }
  }
</script>

<section class="rounded-2xl bg-white dark:bg-paper-800 p-6">
  <div class="flex items-start justify-between gap-3 mb-5">
    <div class="flex-1 min-w-0">
      {#if editing}
        <input
          bind:this={inputEl}
          bind:value={draft}
          onkeydown={onEditKeydown}
          onblur={commitEdit}
          disabled={saving}
          type="text"
          class="block w-full text-xl italic bg-transparent border-b border-claude/60 focus:border-claude outline-none transition disabled:opacity-60"
        />
      {:else}
        <h2
          onclick={startEdit}
          onkeydown={onTitleKeydown}
          role="button"
          tabindex="0"
          title={trackName}
          class="text-xl italic truncate cursor-text hover:text-claude transition"
        >
          {trackName}
        </h2>
      {/if}
    </div>
    <div class="flex items-center gap-1 shrink-0 -mt-1 -mr-2">
      <PitchControl />
      <!-- share: native share sheet on mobile, clipboard copy on desktop -->
      <button
        type="button"
        onclick={share}
        aria-label="share link to this track"
        title={copied ? 'link copied' : 'share link to this track'}
        class="w-9 h-9 rounded-full transition flex items-center justify-center {copied
          ? 'text-claude bg-claude/10'
          : 'text-stone-400 hover:text-claude'}"
      >
        <span class="material-symbols-outlined" style="font-size:22px">
          {copied ? 'check' : 'share'}
        </span>
      </button>

      <!-- mobile-only mixer toggle: shows/hides stems + select-another row -->
      <button
        type="button"
        onclick={() => (expanded = !expanded)}
        aria-label={expanded ? 'hide mixer' : 'show mixer'}
        title={expanded ? 'hide mixer' : 'show mixer'}
        class="lg:hidden w-9 h-9 rounded-full transition flex items-center justify-center {expanded
          ? 'text-claude bg-claude/10'
          : 'text-stone-400 hover:text-claude'}"
      >
        <span class="material-symbols-outlined" style="font-size:24px">tune</span>
      </button>
    </div>
  </div>

  <div
    class="flex flex-col lg:flex-row items-stretch lg:items-center gap-3 lg:gap-2 lg:mb-6 {expanded
      ? 'mb-6'
      : 'mb-0'}"
  >
    <div class="flex items-center gap-2 lg:order-2 lg:flex-1">
      <input
        id="seek"
        type="range"
        min="0"
        max={dur || 100}
        step="0.01"
        value={t}
        style:--p={seekPct.toFixed(2)}
        oninput={onSeek}
        class="flex-1"
      />
      <span class="text-sm text-stone-500 dark:text-stone-400 tabular-nums font-mono">
        {fmtTime(t)} / {fmtTime(dur)}
      </span>
    </div>
    <div class="flex items-center justify-center lg:justify-start gap-2 lg:order-1">
      <button
        onclick={() => engine.nudge(-5)}
        title="back 5s (←)"
        class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-900 hover:border-claude/70 hover:text-claude text-sm tabular-nums font-mono transition"
        >−5s</button
      >
      <button
        onclick={() => engine.toggle()}
        aria-label={playing ? 'pause' : 'play'}
        class="w-12 h-12 rounded-full bg-claude hover:bg-claude-300 text-paper-50 flex items-center justify-center transition shrink-0"
      >
        <span class="material-symbols-outlined" style="font-size:28px">
          {playing ? 'pause' : 'play_arrow'}
        </span>
      </button>
      <button
        onclick={() => engine.nudge(5)}
        title="forward 5s (→)"
        class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-900 hover:border-claude/70 hover:text-claude text-sm tabular-nums font-mono transition"
        >+5s</button
      >
    </div>
  </div>

  <div class="{expanded ? 'block' : 'hidden'} lg:block">
    <StemControls />

    <div class="flex gap-2">
      <button
        onclick={onSelectAnother}
        class="flex-1 px-3 py-2.5 rounded-lg border border-claude/50 text-claude hover:bg-claude hover:text-paper-50 hover:border-claude transition text-sm font-medium flex items-center justify-center gap-2"
      >
        select another song
      </button>
      <button
        onclick={() => (downloadOpen = true)}
        aria-label="download tracks"
        title="download tracks"
        class="px-3 py-2.5 rounded-lg border border-claude/50 text-claude hover:bg-claude hover:text-paper-50 hover:border-claude transition text-sm font-medium flex items-center justify-center gap-2 shrink-0"
      >
        <span class="material-symbols-outlined" style="font-size:20px">download</span>
      </button>
    </div>
  </div>
</section>

{#if app.currentTrack}
  <DownloadDialog
    open={downloadOpen}
    jobId={app.currentTrack.jobId}
    pitch={app.pitch}
    onClose={() => (downloadOpen = false)}
  />
{/if}
