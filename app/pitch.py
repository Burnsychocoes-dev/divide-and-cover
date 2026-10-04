"""Tempo-preserving pitch shifting of separated stems.

Each track gets pre-rendered pitch versions so the player can switch key
instantly: `tracks/{job_id}/pitch/{shift}/{stem}.mp3` for every shift in
`PITCH_SHIFTS` (0 is the original stems at the track root).

The stems are shifted individually (after separation) instead of re-separating
a shifted mix: one demucs pass instead of five, and a shifted stem is a
simpler signal than a shifted mix, so the result is at least as clean.

Method (phase vocoder + resampling):
  1. time-stretch by r = 2^(semitones/12) without changing pitch — STFT,
     identity phase locking around spectral peaks, phase reset on transients;
  2. resample by 1/r — duration is back to the original, every frequency × r.

A peak limiter then catches the peaks the phase changes create. Its gain is
computed from every stem *and* their sum and applied to all stems alike, so
the stem balance is untouched and the full mix in the player doesn't clip.

`render_pitch` runs in a worker process (CPU-bound numpy work).
"""

import shutil
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

import numpy as np
from scipy.ndimage import minimum_filter1d
from scipy.signal import fftconvolve, resample_poly

PITCH_SHIFTS = (-4, -2, 0, 2, 4)  # semitones; 0 = the original stems
LIMIT_CEILING_DB = -1.0  # headroom for mp3 inter-sample overshoot
MP3_BITRATE = "192k"  # matches demucs' `--mp3-bitrate 192`
N_FFT = 4096


def pitch_dir(track: Path, shift: int) -> Path:
    return track / "pitch" / f"{shift:+d}"


def stem_path(track: Path, stem: str, shift: int = 0) -> Path:
    return track / f"{stem}.mp3" if shift == 0 else pitch_dir(track, shift) / f"{stem}.mp3"


def is_ready(track: Path, shift: int, stems: tuple[str, ...]) -> bool:
    return all(stem_path(track, s, shift).exists() for s in stems)


# --- audio i/o ----------------------------------------------------------------

def _load(path: Path) -> tuple[np.ndarray, int]:
    """Decode to float32 (channels, samples) at the file's own rate."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", str(path)],
        capture_output=True, check=True, text=True,
    ).stdout.strip().split(",")
    sr, channels = int(probe[0]), int(probe[1])
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
         "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, channels).T.copy(), sr


def _save_mp3(path: Path, y: np.ndarray, sr: int) -> None:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", str(y.shape[0]),
         "-i", "-", "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, str(path)],
        input=np.ascontiguousarray(y.T, dtype="<f4").tobytes(), check=True,
    )


# --- phase vocoder ------------------------------------------------------------

def _princarg(phase: np.ndarray) -> np.ndarray:
    return (phase + np.pi) % (2 * np.pi) - np.pi


def _find_peaks(mag: np.ndarray) -> np.ndarray:
    """Local maxima of a spectrum (larger than 2 neighbours on each side)."""
    is_peak = np.ones(mag.shape, dtype=bool)
    for s in (1, 2):
        is_peak[s:] &= mag[s:] > mag[:-s]
        is_peak[:-s] &= mag[:-s] >= mag[s:]
    peaks = np.flatnonzero(is_peak)
    return peaks if peaks.size else np.array([int(np.argmax(mag))])


def _detect_onsets(mono: np.ndarray, positions: np.ndarray, win: np.ndarray, n_fft: int) -> np.ndarray:
    """Analysis frames holding a transient (peak of positive spectral flux)."""
    prev = None
    flux = np.zeros(len(positions))
    for i, pos in enumerate(positions):
        logmag = np.log1p(np.abs(np.fft.rfft(mono[pos:pos + n_fft] * win)))
        if prev is not None:
            flux[i] = np.maximum(logmag - prev, 0.0).sum()
        prev = logmag

    onsets = np.zeros(len(positions), dtype=bool)
    half = 8
    for i in range(1, len(flux) - 1):
        local = flux[max(0, i - half):i + half + 1]
        onsets[i] = (flux[i] > flux[i - 1] and flux[i] >= flux[i + 1]
                     and flux[i] > 1.5 * np.median(local) + 0.05 * flux.max())
    return onsets


def time_stretch(x: np.ndarray, stretch: float, n_fft: int = N_FFT) -> np.ndarray:
    """Lengthen x (channels, samples) by `stretch` without changing its pitch."""
    n_ch, length = x.shape
    win = np.hanning(n_fft + 1)[:-1].astype(np.float32)  # periodic Hann
    # analysis hop <= n_fft/4 keeps the instantaneous-frequency estimate unambiguous
    hop_s = max(1, int(round(n_fft / 4 * min(1.0, stretch))))
    hop_a = hop_s / stretch

    pad = n_fft
    xp = np.pad(x, ((0, 0), (pad, pad + n_fft)))
    n_frames = int(np.ceil((length + pad) / hop_a)) + 1
    positions = np.round(np.arange(n_frames) * hop_a).astype(int)
    onsets = _detect_onsets(xp.mean(axis=0), positions, win, n_fft)

    n_bins = n_fft // 2 + 1
    omega = 2 * np.pi * np.arange(n_bins) / n_fft  # centre frequency of each bin
    bins = np.arange(n_bins)
    out_len = (n_frames - 1) * hop_s + n_fft
    y = np.zeros((n_ch, out_len), dtype=np.float32)
    wsum = np.zeros(out_len, dtype=np.float32)
    win_sq = win ** 2

    prev_phi = prev_psi = None
    for i, pos in enumerate(positions):
        X = np.fft.rfft(xp[:, pos:pos + n_fft] * win, axis=1)
        # phases are tracked on the mid channel and the same rotation is applied
        # to every channel, which preserves inter-channel phase (stereo image)
        ref = X.mean(axis=0)
        phi = np.angle(ref)

        if prev_phi is None or onsets[i]:
            psi = phi  # phase reset: keep the original phases, crisp attack
        else:
            peaks = _find_peaks(np.abs(ref))
            dt = pos - positions[i - 1]
            dphi = _princarg(phi[peaks] - prev_phi[peaks] - omega[peaks] * dt)
            psi_peaks = prev_psi[peaks] + hop_s * (omega[peaks] + dphi / dt)
            # identity phase locking: every bin follows its nearest peak
            owner = np.searchsorted((peaks[:-1] + peaks[1:]) / 2, bins)
            psi = psi_peaks[owner] + (phi - phi[peaks][owner])

        Y = X * np.exp(1j * (psi - phi))
        start = i * hop_s
        y[:, start:start + n_fft] += np.fft.irfft(Y, n=n_fft, axis=1) * win
        wsum[start:start + n_fft] += win_sq
        prev_phi, prev_psi = phi, psi

    y /= np.maximum(wsum, 1e-3 * wsum.max())
    # synthesis frame i is centred where analysis frame i was: align centres
    begin = int(round(n_fft / 2 + (pad - n_fft / 2) * stretch))
    return y[:, begin:begin + int(round(length * stretch))]


def pitch_ratio(semitones: float) -> Fraction:
    # rational ratio (< 0.01 cent off) so the polyphase resampling is exact
    return Fraction(2 ** (semitones / 12)).limit_denominator(1000)


def pitch_shift(x: np.ndarray, semitones: float) -> np.ndarray:
    """Shift x (channels, samples) by `semitones`, keeping its exact length."""
    ratio = pitch_ratio(semitones)
    if ratio == 1:
        return x.copy()
    stretched = time_stretch(x, float(ratio))
    y = resample_poly(stretched, ratio.denominator, ratio.numerator, axis=1)
    length = x.shape[1]
    if y.shape[1] < length:
        y = np.pad(y, ((0, 0), (0, length - y.shape[1])))
    return y[:, :length].astype(np.float32)


def limiter_gain(peak: np.ndarray, sr: int, ceiling_db: float = LIMIT_CEILING_DB,
                 lookahead_ms: float = 10.0) -> np.ndarray:
    """Per-sample gain that keeps `peak` (abs envelope) under the ceiling.

    The required gain is spread by a sliding minimum over ±lookahead, then
    smoothed by a Hann kernel of the same support: every smoothed value
    averages minima that all include the peak, so the gain is always enough
    while ramping smoothly (no clicks).
    """
    ceiling = 10 ** (ceiling_db / 20)
    if peak.max() <= ceiling:
        return np.ones_like(peak)
    required = np.minimum(1.0, ceiling / np.maximum(peak, 1e-12))
    half = max(1, int(sr * lookahead_ms / 1000))
    held = minimum_filter1d(required, size=2 * half + 1, mode="nearest")
    kernel = np.hanning(2 * half + 3)[1:-1]
    gain = fftconvolve(np.pad(held, half, mode="edge"), kernel / kernel.sum(), mode="valid")
    return np.minimum(gain, held).astype(np.float32)  # guard against fft rounding


# --- worker entry point --------------------------------------------------------

def render_pitch(track_dir: str, shift: int, stems: tuple[str, ...]) -> None:
    """Render one pitch version of every stem into `pitch/{shift}/`.

    Shifted stems are spooled to disk (float32 .npy) while the shared limiter
    envelope is accumulated, so only one decoded stem is in memory at a time.
    The output folder is renamed into place at the end: it either holds every
    stem or doesn't exist.
    """
    track = Path(track_dir)
    final = pitch_dir(track, shift)
    if is_ready(track, shift, stems):
        return
    final.parent.mkdir(exist_ok=True)  # no parents=: never resurrect a deleted track
    work = Path(tempfile.mkdtemp(prefix=f".tmp{shift:+d}-", dir=final.parent))
    try:
        mix = peak = None
        sr = 0
        for stem in stems:
            x, sr = _load(track / f"{stem}.mp3")
            y = pitch_shift(x, shift)
            del x
            np.save(work / f"{stem}.npy", y)
            stem_peak = np.abs(y).max(axis=0)
            if mix is None:
                mix, peak = y, stem_peak
            else:
                mix += y
                np.maximum(peak, stem_peak, out=peak)
        np.maximum(peak, np.abs(mix).max(axis=0), out=peak)
        del mix
        gain = limiter_gain(peak, sr)

        for stem in stems:
            y = np.load(work / f"{stem}.npy")
            _save_mp3(work / f"{stem}.mp3", y * gain, sr)
            (work / f"{stem}.npy").unlink()

        if final.exists():  # a concurrent render won the race
            return
        work.rename(final)
    finally:
        shutil.rmtree(work, ignore_errors=True)
