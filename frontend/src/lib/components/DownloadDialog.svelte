<script lang="ts">
  import { STEMS, type Stem } from '$lib/state.svelte';
  import { mixUrl } from '$lib/api';
  import { lockScroll } from '$lib/actions/lockScroll';
  import { swipeDown } from '$lib/actions/swipeDown';

  type Props = { open: boolean; jobId: string; pitch?: number; onClose: () => void };
  let { open, jobId, pitch = 0, onClose }: Props = $props();

  let panelEl: HTMLDivElement | null = $state(null);

  // all stems checked by default
  let checked = $state<Record<Stem, boolean>>({
    vocals: true,
    drums: true,
    bass: true,
    other: true
  });

  // reset selection every time the dialog opens
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      checked = { vocals: true, drums: true, bass: true, other: true };
    }
    wasOpen = open;
  });

  const selected = $derived(STEMS.filter((s) => checked[s]));

  function toggle(s: Stem) {
    checked = { ...checked, [s]: !checked[s] };
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function download() {
    if (selected.length === 0) return;
    const a = document.createElement('a');
    a.href = mixUrl(jobId, selected, pitch);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (open && e.key === 'Escape') onClose();
  }}
/>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:lockScroll
    onclick={onBackdrop}
    class="fixed inset-0 z-50 bg-paper-950/55 backdrop-blur-sm flex items-center justify-center p-4 animate-[fadeIn_0.2s_ease] max-md:items-end max-md:p-0"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={panelEl}
      onclick={(e) => e.stopPropagation()}
      class="relative bg-paper-50 text-paper-900 dark:bg-paper-900 dark:text-paper-50 font-serif rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.25)] w-full max-w-[440px] max-h-[calc(100vh-4rem)] overflow-y-auto overflow-x-hidden animate-[scaleIn_0.2s_ease] max-md:rounded-b-none max-md:max-w-none max-md:max-h-[90vh] max-md:animate-[slideUp_0.3s_ease] flex flex-col"
    >
      <header
        use:swipeDown={{ onClose, target: panelEl ?? undefined }}
        class="px-5 py-4 border-b border-stone-200 dark:border-stone-800 touch-none"
      >
        <div
          aria-hidden="true"
          class="md:hidden mx-auto mb-3 h-1.5 w-9 rounded-full bg-stone-300 dark:bg-stone-700"
        ></div>
        <div class="flex items-center justify-between">
          <h2 class="text-xl italic">download</h2>
          <button
            type="button"
            aria-label="close"
            onclick={onClose}
            class="w-9 h-9 rounded-full border border-stone-300 dark:border-stone-700 hover:border-claude hover:text-claude transition flex items-center justify-center"
          >
            <span class="material-symbols-outlined" style="font-size:20px">close</span>
          </button>
        </div>
      </header>

      <div class="px-5 py-4 flex flex-col gap-4">
        <p class="text-sm text-stone-500 dark:text-stone-400">
          pick the tracks to mix into one file{#if pitch}, at the current pitch
            ({pitch > 0 ? '+' : '−'}{Math.abs(pitch)} semitones){/if}.
        </p>

        <ul class="grid gap-2 list-none p-0 m-0">
          {#each STEMS as stem (stem)}
            {@const on = checked[stem]}
            <li>
              <button
                type="button"
                onclick={() => toggle(stem)}
                aria-pressed={on}
                class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left capitalize transition {on
                  ? 'border-claude bg-claude/10 text-claude'
                  : 'border-stone-300 dark:border-stone-700 text-stone-500 dark:text-stone-400 hover:border-stone-500 dark:hover:border-stone-500'}"
              >
                <span
                  class="w-5 h-5 rounded border flex items-center justify-center shrink-0 transition {on
                    ? 'bg-claude border-claude text-paper-50'
                    : 'border-stone-400 dark:border-stone-600'}"
                >
                  {#if on}
                    <span class="material-symbols-outlined" style="font-size:16px">check</span>
                  {/if}
                </span>
                {stem}
              </button>
            </li>
          {/each}
        </ul>

        <button
          type="button"
          onclick={download}
          disabled={selected.length === 0}
          class="w-full px-3 py-2.5 rounded-lg bg-claude text-paper-50 hover:bg-claude-300 transition text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span class="material-symbols-outlined" style="font-size:20px">download</span>
          {#if selected.length === 0}
            select at least one track
          {:else if selected.length === STEMS.length}
            download full mix
          {:else}
            download {selected.join(' + ')}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
