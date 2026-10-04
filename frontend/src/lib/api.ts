// Typed API client + NDJSON stream reader. Mirrors app/main.py endpoints.

import { STEMS, type Stem } from './player';

export type StreamEvent =
  | { event: 'stage'; stage: string; message?: string }
  | { event: 'progress'; stage: string; percent: number }
  | { event: 'log'; stage: string; message: string }
  | { event: 'done'; job_id: string; name: string; stems: Record<Stem, string> }
  | { event: 'error'; message: string };

export type Track = {
  job_id: string;
  name: string;
  created_at: number;
  video_id?: string | null;
};

/** A detached separation job as reported by the backend registry. */
export type JobSnapshot = {
  id: string;
  name: string;
  kind: 'upload' | 'youtube';
  video_id?: string | null;
  status: 'running' | 'done' | 'error';
  stage: string;
  percent: number;
  message: string;
  stems: Record<Stem, string> | null;
  error?: string | null;
  created_at: number;
};

export type YTHit = {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string;
  url: string;
};

export type LyricsResult = {
  found: boolean;
  reason?: string;
  /** lrclib id of the matched record — used to highlight "current" in the search dialog */
  id?: number;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  instrumental?: boolean;
  lines?: { t: number; text: string }[];
  plain?: string;
  query?: string;
  /** seconds added to every line.t when matching against playback time */
  offset?: number;
};

export type LyricsSearchHit = {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  duration: number | null;
  instrumental: boolean;
  has_sync: boolean;
  has_plain: boolean;
};

export async function* readNdjson(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.body) throw new Error('no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line) as StreamEvent;
    }
  }
  const tail = buf.trim();
  if (tail) yield JSON.parse(tail) as StreamEvent;
}

/** Pre-rendered pitch versions, in semitones (0 = the original stems). Mirrors app/pitch.py. */
export const PITCH_SHIFTS = [-4, -2, 0, 2, 4] as const;

export type PitchStatus = { ready: number[]; pending: number[]; failed: number[] };

export function stemUrlsFor(jobId: string, pitch = 0): Record<Stem, string> {
  const out = {} as Record<Stem, string>;
  const qs = pitch ? `?pitch=${pitch}` : '';
  for (const s of STEMS) out[s] = `/api/stem/${jobId}/${s}${qs}`;
  return out;
}

/** URL that mixes the given stems into a single downloadable mp3. */
export function mixUrl(jobId: string, stems: Stem[], pitch = 0): string {
  const params = new URLSearchParams({ stems: stems.join(',') });
  if (pitch) params.set('pitch', String(pitch));
  return `/api/mix/${jobId}?${params}`;
}

/** Which pitch versions of a track are playable. Also starts rendering missing ones server-side. */
export async function fetchPitches(jobId: string): Promise<PitchStatus> {
  const r = await fetch(`/api/tracks/${jobId}/pitches`);
  if (!r.ok) throw new Error(`fetchPitches: ${r.status}`);
  return r.json();
}

export async function listTracks(): Promise<Track[]> {
  const res = await fetch('/api/tracks');
  if (!res.ok) throw new Error(`listTracks: ${res.status}`);
  const data = await res.json();
  return data.tracks ?? [];
}

export async function deleteTrack(jobId: string): Promise<void> {
  const res = await fetch(`/api/tracks/${jobId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteTrack: ${res.status}`);
}

export async function renameTrack(jobId: string, name: string): Promise<{ name: string }> {
  const res = await fetch(`/api/tracks/${jobId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** Kick off a detached upload separation. Returns the job id to subscribe to. */
export async function createSeparateFile(file: File): Promise<{ job_id: string }> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/separate', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/** Kick off a detached youtube separation. `existing` => already in the library. */
export async function createSeparateYouTube(
  videoId: string,
  name?: string
): Promise<{ job_id: string; name?: string; existing?: boolean }> {
  const r = await fetch('/api/separate-youtube', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, name: name ?? null })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function listJobs(): Promise<JobSnapshot[]> {
  const r = await fetch('/api/jobs');
  if (!r.ok) throw new Error(`listJobs: ${r.status}`);
  const data = await r.json();
  return data.jobs ?? [];
}

/** Open a progress subscription for a job. Caller drives it with readNdjson(). */
export function jobEvents(jobId: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`/api/jobs/${jobId}/events`, { signal });
}

/** Interrupt an in-progress job. */
export async function cancelJob(jobId: string): Promise<void> {
  const r = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
  if (!r.ok) throw new Error(`cancelJob: ${r.status}`);
}

export async function ytSearch(
  q: string,
  limit = 10,
  offset = 0
): Promise<{ results: YTHit[]; has_more: boolean }> {
  const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
  const r = await fetch(`/api/search?${params}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchVideoInfo(videoId: string): Promise<YTHit> {
  const r = await fetch(`/api/video/${encodeURIComponent(videoId)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchLyrics(
  jobId: string,
  opts: { q?: string; refresh?: boolean } = {}
): Promise<LyricsResult> {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.refresh) params.set('refresh', '1');
  const url = `/api/lyrics/${jobId}${params.toString() ? '?' + params : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

export async function searchLyrics(q: string): Promise<LyricsSearchHit[]> {
  const r = await fetch(`/api/lyrics-search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  return data.results ?? [];
}

export async function selectLyrics(jobId: string, lrclibId: number): Promise<LyricsResult> {
  const r = await fetch(`/api/lyrics/${jobId}/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lrclib_id: lrclibId })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function pasteLyrics(jobId: string, text: string): Promise<LyricsResult> {
  const r = await fetch(`/api/lyrics/${jobId}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getSavedPaste(jobId: string): Promise<string | null> {
  const r = await fetch(`/api/lyrics/${jobId}/paste`);
  if (!r.ok) return null;
  const data = await r.json();
  return typeof data.text === 'string' ? data.text : null;
}

export async function saveLyricsOffset(jobId: string, offset: number): Promise<void> {
  const r = await fetch(`/api/lyrics/${jobId}/offset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset })
  });
  if (!r.ok) throw new Error(await r.text());
}
