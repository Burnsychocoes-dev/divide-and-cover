// Web Audio engine — N independent stem buffers playing in lockstep with per-stem gain/mute.
// Ported from app/static/app.js (lines 191-396). Framework-agnostic; components subscribe via callbacks.

export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const;
export type Stem = (typeof STEMS)[number];

export type PlayerSnapshot = {
  playing: boolean;
  currentTime: number;
  duration: number;
  muted: Record<Stem, boolean>;
  volumes: Record<Stem, number>;
};

// crossfade length when swapping versions mid-playback (see swap())
const SWAP_FADE = 0.04;

export class StemPlayer {
  private ctx: AudioContext | null = null;
  private buffers: Partial<Record<Stem, AudioBuffer>> = {};
  private gains: Partial<Record<Stem, GainNode>> = {};
  private sources: Partial<Record<Stem, AudioBufferSourceNode>> = {};
  // per-source fade node (source -> voice -> stem gain), used to crossfade on swap()
  private voices: Partial<Record<Stem, GainNode>> = {};
  // encoded mp3 bytes by url, for the current track only — lets prefetch() warm
  // up other versions (pitches) so swap() only has to decode
  private bytes = new Map<string, Promise<ArrayBuffer>>();
  private swapSeq = 0;
  private muted: Record<Stem, boolean> = { vocals: false, drums: false, bass: false, other: false };
  private volumes: Record<Stem, number> = { vocals: 1, drums: 1, bass: 1, other: 1 };

  private playing = false;
  private startCtxTime = 0;
  private startOffset = 0;
  private duration = 0;
  private rafId: number | null = null;

  // listener invoked every animation frame while playing, plus once on every state change
  onUpdate: (snap: PlayerSnapshot) => void = () => {};
  onEnded: () => void = () => {};

  /**
   * Decode all stems and prepare gain nodes. Resets prior state.
   * @param onProgress called with 0..100 as the download progresses.
   *   Sums bytes received across all four parallel fetches.
   */
  async load(
    stemUrls: Record<Stem, string>,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    this.stopRaf();
    this.detachSources();
    this.buffers = {};
    this.gains = {};
    this.bytes.clear();
    this.swapSeq++; // drop any in-flight swap of the previous track

    if (!this.ctx) {
      const Ctor =
        (window.AudioContext as typeof AudioContext) ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    const decoded = await this.decodeAll(stemUrls, onProgress);
    const ctx = this.ctx;

    for (const [s, buf] of decoded) {
      this.buffers[s] = buf;
      const g = ctx.createGain();
      g.gain.value = this.muted[s] ? 0 : this.volumes[s];
      g.connect(ctx.destination);
      this.gains[s] = g;
    }

    this.duration = decoded[0][1].duration;
    this.startOffset = 0;
    this.playing = false;
    this.emit();
  }

  /**
   * Replace the stems with another version of the same track (e.g. another
   * pitch), keeping the playback position, volumes and mutes. While playing,
   * old and new versions are crossfaded over SWAP_FADE so the switch is
   * seamless. Resolves false if a newer swap()/load() superseded this one.
   */
  async swap(stemUrls: Record<Stem, string>): Promise<boolean> {
    const seq = ++this.swapSeq;
    const decoded = await this.decodeAll(stemUrls);
    if (seq !== this.swapSeq || !this.ctx) return false;

    if (!this.playing) {
      for (const [s, buf] of decoded) this.buffers[s] = buf;
      this.emit();
      return true;
    }

    const when = this.ctx.currentTime + 0.05;
    const offset = this.startOffset + (when - this.startCtxTime);
    for (const s of STEMS) {
      const voice = this.voices[s];
      voice?.gain.setValueAtTime(1, when);
      voice?.gain.linearRampToValueAtTime(0, when + SWAP_FADE);
      this.sources[s]?.stop(when + SWAP_FADE);
    }
    for (const [s, buf] of decoded) this.buffers[s] = buf;
    this.startCtxTime = when;
    this.startOffset = offset;
    this.startSources(when, offset, true);
    return true;
  }

  /** Download (not decode) another version's stems in the background. */
  prefetch(stemUrls: Record<Stem, string>): void {
    for (const s of STEMS) void this.fetchBytes(stemUrls[s]).catch(() => {});
  }

  private fetchBytes(
    url: string,
    onBytes?: (got: number, total: number) => void
  ): Promise<ArrayBuffer> {
    let p = this.bytes.get(url);
    if (!p) {
      p = (async () => {
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`fetch ${url}: ${res.status}`);
        const len = Number(res.headers.get('content-length')) || 0;
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let got = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          onBytes?.(got, len);
        }
        // concat into a single ArrayBuffer for decodeAudioData
        const merged = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        return merged.buffer;
      })();
      this.bytes.set(url, p);
      p.catch(() => this.bytes.delete(url)); // let a failed fetch be retried
    }
    return p;
  }

  private async decodeAll(
    stemUrls: Record<Stem, string>,
    onProgress?: (percent: number) => void
  ): Promise<[Stem, AudioBuffer][]> {
    const ctx = this.ctx!;
    const received: Record<Stem, number> = { vocals: 0, drums: 0, bass: 0, other: 0 };
    const total: Record<Stem, number> = { vocals: 0, drums: 0, bass: 0, other: 0 };
    const report = () => {
      if (!onProgress) return;
      let r = 0;
      let t = 0;
      for (const k of STEMS) {
        r += received[k];
        t += total[k];
      }
      if (t > 0) onProgress(Math.min(100, (r / t) * 100));
    };

    const decoded = await Promise.all(
      STEMS.map(async (s): Promise<[Stem, AudioBuffer]> => {
        const bytes = await this.fetchBytes(stemUrls[s], (got, len) => {
          received[s] = got;
          total[s] = len;
          report();
        });
        // decodeAudioData detaches its input: decode a copy, keep the cached bytes
        return [s, await ctx.decodeAudioData(bytes.slice(0))];
      })
    );

    // ensure final 100% even if a content-length header was missing
    if (onProgress) onProgress(100);
    return decoded;
  }

  play(): void {
    if (this.playing || !this.ctx) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    const when = this.ctx.currentTime + 0.05;
    this.startCtxTime = when;
    this.startSources(when, this.startOffset, false);

    this.playing = true;
    this.emit();
    this.startRaf();
  }

  private startSources(when: number, offset: number, fadeIn: boolean): void {
    const ctx = this.ctx!;
    for (const s of STEMS) {
      const buf = this.buffers[s];
      const gain = this.gains[s];
      if (!buf || !gain) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const voice = ctx.createGain();
      if (fadeIn) {
        voice.gain.setValueAtTime(0, when);
        voice.gain.linearRampToValueAtTime(1, when + SWAP_FADE);
      }
      src.connect(voice).connect(gain);
      src.start(when, offset);
      this.sources[s] = src;
      this.voices[s] = voice;
    }
  }

  pause(): void {
    if (!this.playing || !this.ctx) return;
    this.startOffset += Math.max(0, this.ctx.currentTime - this.startCtxTime);
    this.detachSources();
    this.playing = false;
    this.stopRaf();
    this.emit();
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  seekTo(t: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.startOffset = Math.max(0, Math.min(this.duration, t));
    this.emit();
    if (wasPlaying) this.play();
  }

  nudge(seconds: number): void {
    if (!this.duration) return;
    this.seekTo(this.getTime() + seconds);
  }

  setMuted(stem: Stem, m: boolean): void {
    this.muted[stem] = m;
    const g = this.gains[stem];
    if (g) g.gain.value = m ? 0 : this.volumes[stem];
    this.emit();
  }

  setVolume(stem: Stem, v: number): void {
    this.volumes[stem] = v;
    const g = this.gains[stem];
    if (g && !this.muted[stem]) g.gain.value = v;
    this.emit();
  }

  getTime(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime);
  }

  getDuration(): number {
    return this.duration;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** Tear down all per-track state. Keep the AudioContext for reuse. */
  reset(): void {
    this.pause();
    this.bytes.clear();
    this.swapSeq++;
    this.buffers = {};
    this.gains = {};
    this.duration = 0;
    this.startOffset = 0;
    this.muted = { vocals: false, drums: false, bass: false, other: false };
    this.volumes = { vocals: 1, drums: 1, bass: 1, other: 1 };
    this.emit();
  }

  private snapshot(): PlayerSnapshot {
    return {
      playing: this.playing,
      currentTime: this.getTime(),
      duration: this.duration,
      muted: { ...this.muted },
      volumes: { ...this.volumes }
    };
  }

  private emit(): void {
    this.onUpdate(this.snapshot());
  }

  private startRaf(): void {
    const tick = () => {
      if (!this.playing) return;
      const t = this.getTime();
      if (t >= this.duration) {
        this.pause();
        this.startOffset = 0;
        this.emit();
        this.onEnded();
        return;
      }
      this.emit();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private detachSources(): void {
    for (const s of STEMS) {
      const src = this.sources[s];
      if (src) {
        try {
          src.stop();
        } catch {
          /* not started */
        }
      }
    }
    this.sources = {};
    this.voices = {};
  }
}
