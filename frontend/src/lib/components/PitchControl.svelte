<script lang="ts">
  import { engine, app } from '$lib/state.svelte';
  import { fetchPitches, stemUrlsFor, PITCH_SHIFTS } from '$lib/api';

  const STEP = 2; // semitones per click — the server renders -4, -2, 0, +2, +4
  const POLL_MS = 4000;

  type VersionState = 'ready' | 'pending' | 'failed' | 'none';

  // the version being loaded counts as the current one, so clicks chain from it
  const shown = $derived(app.pitchSwitching ?? app.pitch);

  function stateOf(p: number): VersionState {
    if (!(PITCH_SHIFTS as readonly number[]).includes(p)) return 'none';
    if (p === 0 || app.pitchStatus?.ready.includes(p)) return 'ready';
    if (app.pitchStatus?.failed.includes(p)) return 'failed';
    return 'pending';
  }

  function fmt(p: number): string {
    return p > 0 ? `+${p}` : p < 0 ? `−${-p}` : '0';
  }

  /** Download the versions one click away so switching only has to decode. */
  function prefetchNeighbours(jobId: string) {
    for (const p of [app.pitch - STEP, app.pitch + STEP]) {
      if (p !== 0 && stateOf(p) === 'ready') engine.prefetch(stemUrlsFor(jobId, p));
    }
  }

  // Poll the server until every version of the loaded track is rendered (the
  // first request also kicks off rendering for tracks split before pitch
  // support existed).
  $effect(() => {
    const jobId = app.currentTrack?.jobId;
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await fetchPitches(jobId);
        if (stopped) return;
        app.pitchStatus = status;
        prefetchNeighbours(jobId);
        if (status.pending.length) timer = setTimeout(poll, POLL_MS);
      } catch {
        if (!stopped) timer = setTimeout(poll, POLL_MS * 2);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  async function step(dir: -1 | 1) {
    const target = shown + dir * STEP;
    if (stateOf(target) !== 'ready' || !app.currentTrack) return;
    const jobId = app.currentTrack.jobId;
    app.pitchSwitching = target;
    try {
      const applied = await engine.swap(stemUrlsFor(jobId, target));
      if (applied && app.currentTrack?.jobId === jobId) {
        app.pitch = target;
        prefetchNeighbours(jobId);
      }
    } catch {
      // fetch/decode failed — keep playing the current version
    } finally {
      if (app.pitchSwitching === target) app.pitchSwitching = null;
    }
  }

  function title(dir: -1 | 1): string {
    const target = shown + dir * STEP;
    const label = `${fmt(target)} semitones`;
    switch (stateOf(target)) {
      case 'ready':
        return `pitch ${dir < 0 ? 'down' : 'up'} (${label})`;
      case 'pending':
        return `preparing ${label}…`;
      case 'failed':
        return `${label} unavailable`;
      default:
        return dir < 0 ? 'lowest pitch' : 'highest pitch';
    }
  }
</script>

{#snippet stepButton(dir: -1 | 1)}
  {@const st = stateOf(shown + dir * STEP)}
  <button
    type="button"
    onclick={() => step(dir)}
    disabled={st !== 'ready'}
    aria-label={title(dir)}
    title={title(dir)}
    class="w-8 h-full rounded-full flex items-center justify-center transition text-stone-500 dark:text-stone-400 enabled:hover:text-claude {st ===
    'pending'
      ? 'cursor-wait'
      : 'disabled:opacity-35'}"
  >
    {#if st === 'pending'}
      <span
        class="material-symbols-outlined"
        style="font-size:15px;animation:spin 1.2s linear infinite">progress_activity</span
      >
    {:else}
      <span class="material-symbols-outlined" style="font-size:18px">
        {dir < 0 ? 'remove' : 'add'}
      </span>
    {/if}
  </button>
{/snippet}

<div
  role="group"
  aria-label="pitch"
  title="pitch, in semitones — the tempo doesn't change"
  class="h-9 flex items-center rounded-full border border-stone-300 dark:border-stone-700 bg-paper-50 dark:bg-paper-900"
>
  {@render stepButton(-1)}
  <span
    class="min-w-7 text-center text-sm font-mono tabular-nums {shown !== 0
      ? 'text-claude'
      : 'text-stone-500 dark:text-stone-400'} {app.pitchSwitching !== null ? 'animate-pulse' : ''}"
  >
    {fmt(shown)}
  </span>
  {@render stepButton(1)}
</div>
