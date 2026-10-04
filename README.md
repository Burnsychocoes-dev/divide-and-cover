# divide and cover

Drop a song, get four stems. Web UI on top of [demucs](https://github.com/adefossez/demucs).

<table>
<tr>
<td>

![](screenshots/1.png)

</td>
<td>

![](screenshots/2.png)

</td>
</tr>
</table>

## Run

Requires [uv](https://docs.astral.sh/uv/) and Python 3.11.

```bash
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>.

### Where does demucs run?

By default, demucs runs **locally** as a subprocess. On Apple Silicon a 3-min
song takes ~30–90 s. The first split downloads the `htdemucs` weights into
`~/.cache/torch/hub/`; subsequent splits reuse them.

To offload demucs to a **Modal serverless GPU** instead, drop your Modal
credentials into a gitignored `.env`:

```bash
# .env (gitignored)
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

Then:

```bash
# one-time
uv run --env-file .env modal deploy modal_app.py

# every run — DAC_USE_MODAL=1 makes the toggle explicit at the call site
DAC_USE_MODAL=1 uv run --env-file .env uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Drop the `DAC_USE_MODAL=1` prefix to fall back to local demucs.

Warm Modal splits take ~15–25 s; the first one of a session pays ~30 s of
cold start. The free $30/month credit covers thousands of songs. See
[MODAL.md](MODAL.md) for how the integration actually works.

## Player

Once split, the four stems (`vocals`, `drums`, `bass`, `other`) play in
sample-accurate sync via the Web Audio API. Click any stem name to mute/unmute,
drag its slider for per-stem volume, the seek bar to scrub, or hit space to
play/pause.

## Pitch

The `− 0 +` control next to the track title changes the key in steps of two
semitones (−4, −2, 0, +2, +4) without changing the tempo. Switching happens
mid-playback at the same position with a short crossfade; the lyrics, which
belong to the track, stay in sync.

Each version is pre-rendered on the API host right after the split: the four
stems are pitch-shifted individually (phase vocoder with identity phase
locking and transient preservation, then resampling — see `app/pitch.py`) and
a peak limiter shared by the four stems keeps the full mix from clipping. The
original is playable straight away; ±2 are ready first, then ±4 (a few minutes
of CPU for a typical song). Tracks split before this feature get their
versions rendered the first time they're opened.

`DAC_PITCH_WORKERS` (default `2`) sets how many versions render in parallel —
each worker needs roughly 0.5–1 GB of RAM for a 5-minute song.

## Library

Past splits show up under the player. Click a track to load it; click `✕` to
delete its folder.

## Storage

Splits live in `tracks/{job_id}/{vocals,drums,bass,other}.mp3` plus a
`meta.json`, with the pitch versions in `tracks/{job_id}/pitch/{-4,-2,+2,+4}/`. The original upload is discarded after the split completes. The
folder is gitignored — clean up via the UI or `rm -rf tracks/`.

## Layout

- `modal_app.py` — Modal app exposing the `divide-and-cover/separate`
  function: pulls demucs + htdemucs weights into the image, runs on a T4 GPU,
  returns the four mp3 stems as bytes.
- `app/pitch.py` — tempo-preserving pitch shifting of the stems.
- `app/main.py` — FastAPI:
  - `POST /api/separate` — uploads bytes to the Modal function, persists stems.
  - `POST /api/separate-youtube` — yt-dlp downloads the audio locally, then
    forwards bytes to Modal.
  - `GET /api/tracks` — list past splits.
  - `DELETE /api/tracks/{job_id}` — remove a split.
  - `GET /api/stem/{job_id}/{stem}?pitch=N` — serve a stem mp3 (`pitch` in
    semitones, default 0 = original).
  - `GET /api/tracks/{job_id}/pitches` — which pitch versions are ready;
    starts rendering missing ones.
  - `GET /api/mix/{job_id}?stems=…&pitch=N` — download a mix of some stems.
  - `GET /api/lyrics/{job_id}` — fetch synced lyrics for a track from lrclib.
- `app/static/` — single-page Tailwind (CDN) + vanilla JS frontend.
