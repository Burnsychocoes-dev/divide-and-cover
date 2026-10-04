<script lang="ts">
  import { onMount } from 'svelte';
  import { engine, app, STEMS, type Stem } from '$lib/state.svelte';
  import {
    listTracks,
    createSeparateFile,
    createSeparateYouTube,
    stemUrlsFor
  } from '$lib/api';
  import { jobs, type JobProgress } from '$lib/jobs.svelte';

  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import DropZone from '$lib/components/DropZone.svelte';
  import ProgressView from '$lib/components/ProgressView.svelte';
  import Player from '$lib/components/Player.svelte';
  import YouTubeSearch from '$lib/components/YouTubeSearch.svelte';
  import Lyrics from '$lib/components/Lyrics.svelte';

  let searchOpen = $state(false);

  async function refreshLibrary() {
    try {
      app.tracks = await listTracks();
    } catch {
      app.tracks = [];
    }
  }

  // --- shareable URL: ?track=<jobId> --------------------------------------

  const TRACK_PARAM = 'track';

  function syncUrlToCurrentTrack() {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const desired = app.currentTrack?.jobId ?? null;
    const present = params.get(TRACK_PARAM);
    if (desired === present) return;
    if (desired) params.set(TRACK_PARAM, desired);
    else params.delete(TRACK_PARAM);
    const qs = params.toString();
    const next = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState({}, '', next);
  }

  // The `$effect` below would fire on its initial pass with
  // `app.currentTrack === null` and helpfully strip the `?track=` param
  // before onMount could read it — a race against the async load. We gate
  // it with a plain flag (not $state, so the effect doesn't re-run when the
  // flag itself flips) and call `syncUrlToCurrentTrack` once explicitly at
  // the end of onMount.
  let initialUrlLoadPending = true;
  $effect(() => {
    app.currentTrack; // dependency
    if (initialUrlLoadPending) return;
    syncUrlToCurrentTrack();
  });

  // Reconnect to server-side jobs whenever the tab becomes visible again
  // (covers mobile tab suspension dropping the progress stream). A plain
  // $effect, not async onMount — async onMount can't return a teardown.
  $effect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void jobs.discover();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  onMount(async () => {
    // pick up any jobs already running server-side (e.g. started before a
    // reload, or in another tab) and reconnect to their progress streams
    jobs.onComplete = onJobComplete;
    void jobs.discover();

    // DEV: `?fakejob` seeds a fake job stuck at 50% for tweaking the UI.
    if (new URLSearchParams(window.location.search).has('fakejob')) jobs.seedFake();

    await refreshLibrary();
    const params = new URLSearchParams(window.location.search);
    const initialId = params.get(TRACK_PARAM);
    if (initialId) {
      const track = app.tracks.find((t) => t.job_id === initialId);
      if (track) {
        await loadFromLibrary(track.job_id, track.name);
      }
      // if not found, the trailing syncUrlToCurrentTrack() below will strip the param
    }
    initialUrlLoadPending = false;
    syncUrlToCurrentTrack();
  });

  // --- detached separation jobs --------------------------------------------
  //
  // Jobs run server-side and are tracked in the `jobs` store; progress for the
  // focused job is mirrored into `app.status` by the store. We only react to
  // completion here.

  function onJobComplete(job: JobProgress) {
    // "watching" = this is the job the user kicked off and is still parked on
    // its progress screen. Any other finish (a concurrent background job, or
    // one they've navigated away from) is just marked ready in the library.
    const watching = jobs.focusedId === job.id && app.view === 'status';
    if (job.status === 'error') {
      if (watching) fail(job.error ?? 'failed');
      jobs.forget(job.id);
      return;
    }
    // done — refresh so it shows in the library ("ready"); only load into the
    // player if the user is actively watching this job's progress.
    refreshLibrary();
    if (watching && job.stems) {
      app.status = { stage: 'loading', percent: 0, message: 'downloading tracks…' };
      void loadPlayer(job.id, job.name, job.stems);
    }
    jobs.forget(job.id);
  }

  async function loadPlayer(
    jobId: string,
    name: string,
    stemUrls: Record<Stem, string>
  ): Promise<void> {
    app.view = 'status';
    try {
      await engine.load(stemUrls, (pct) => {
        app.status = { ...app.status, percent: pct };
      });
    } catch (e) {
      return fail(`load failed: ${e}`);
    }
    app.currentTrack = { jobId, name };
    app.view = 'player';
  }

  function fail(msg: string) {
    app.status = { stage: 'failed', percent: 0, message: msg };
    setTimeout(() => {
      if (app.view === 'status') app.view = 'drop';
    }, 4000);
  }

  /** Stop the currently playing track and detach it from the UI before
   *  kicking off any new split / load — otherwise the lyrics pane and the
   *  in-memory audio of the previous song stick around during the progress
   *  view. */
  function clearActiveTrack() {
    engine.pause();
    app.currentTrack = null;
    // every load starts from the original stems
    app.pitch = 0;
    app.pitchSwitching = null;
    app.pitchStatus = null;
  }

  async function onFile(file: File) {
    clearActiveTrack();
    app.view = 'status';
    app.status = { stage: 'uploading', percent: 0, message: file.name };
    const name = file.name.replace(/\.[^/.]+$/, '');
    try {
      const { job_id } = await createSeparateFile(file);
      jobs.start(job_id, name, { focus: true });
    } catch (e) {
      fail(`request failed: ${e}`);
    }
  }

  async function onYoutubePick(videoId: string, title: string) {
    clearActiveTrack();
    app.view = 'status';
    app.status = { stage: 'downloading_audio', percent: 0, message: title };
    try {
      const res = await createSeparateYouTube(videoId, title);
      if (res.existing) {
        // already in the library — load it directly, no job
        await loadFromLibrary(res.job_id, res.name ?? title);
        return;
      }
      jobs.start(res.job_id, title, { focus: true, videoId });
    } catch (e) {
      fail(`request failed: ${e}`);
    }
  }

  async function loadFromLibrary(jobId: string, name: string) {
    clearActiveTrack();
    app.view = 'status';
    app.status = { stage: 'loading', percent: 0, message: name };
    try {
      await engine.load(stemUrlsFor(jobId), (pct) => {
        app.status = { ...app.status, percent: pct };
      });
      app.currentTrack = { jobId, name };
      app.view = 'player';
    } catch (e) {
      fail(`load failed: ${e}`);
    }
  }

  function onSelectAnother() {
    // open the merged search/library dialog without tearing down the current
    // player — if the user closes without picking, they return to playback;
    // if they pick something, loadFromLibrary / onYoutubePick replaces it.
    refreshLibrary();
    searchOpen = true;
  }

  // --- keyboard shortcuts (only when player visible) ------------------------

  function isTextEntry(el: HTMLElement | null): boolean {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      // text-like inputs swallow keys; range / checkbox / radio / buttons don't
      const t = (el as HTMLInputElement).type;
      return t !== 'range' && t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit';
    }
    return false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (isTextEntry(e.target as HTMLElement | null)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      engine.toggle();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      engine.nudge(-5);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      engine.nudge(5);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!--
  Mobile layout: the entire viewport is one fixed-height flex column.
  Nothing on the page scrolls — only the lyrics list inside its aside does.
  Desktop falls back to natural-flow layout via lg: overrides.
-->
<main
  class="mx-auto max-w-2xl px-6 py-4 lg:max-w-none lg:px-10 lg:py-14 h-dvh flex flex-col overflow-hidden lg:h-auto lg:block lg:overflow-visible"
>
  <header
    class="flex-none mb-4 lg:mb-10 flex items-center justify-between gap-4 lg:max-w-[36rem]"
  >
    <h1 class="text-4xl font-semibold tracking-tight italic text-claude leading-none">
      <button
        type="button"
        onclick={() => (searchOpen = true)}
        title="open library / search youtube"
        class="hover:text-claude-300 cursor-pointer transition"
      >
        divide and cover
      </button>
    </h1>
    <ThemeToggle />
  </header>

  <div class="flex-1 min-h-0 flex flex-col lg:flex-row lg:items-start lg:gap-8">
    <div class="flex-none lg:w-[36rem] lg:flex-none lg:min-w-0">
      <h3 class="hidden lg:block text-xs uppercase tracking-[0.2em] text-stone-500 mb-3">player</h3>

      {#if app.view === 'drop'}
        <DropZone onFile={onFile} onOpenSearch={() => (searchOpen = true)} />
      {:else if app.view === 'status'}
        <ProgressView />
      {:else}
        <Player onSelectAnother={onSelectAnother} />
      {/if}
    </div>

    <Lyrics />
  </div>
</main>

<YouTubeSearch
  open={searchOpen}
  onClose={() => (searchOpen = false)}
  onLoadLibrary={loadFromLibrary}
  onPickYouTube={onYoutubePick}
  onAfterDelete={refreshLibrary}
  onFile={onFile}
  onRefresh={refreshLibrary}
/>
