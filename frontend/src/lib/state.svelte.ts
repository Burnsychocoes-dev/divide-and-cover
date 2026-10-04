// Cross-component reactive state. One instance of StemPlayer + a few runes-backed fields.
// Components import `state` and `engine`; mutations flow through `engine.onUpdate -> state.player`.

import { StemPlayer, STEMS, type PlayerSnapshot, type Stem } from './player';
import type { PitchStatus, Track } from './api';

class AppState {
  player = $state<PlayerSnapshot>({
    playing: false,
    currentTime: 0,
    duration: 0,
    muted: { vocals: false, drums: false, bass: false, other: false },
    volumes: { vocals: 1, drums: 1, bass: 1, other: 1 }
  });

  currentTrack = $state<{ jobId: string; name: string } | null>(null);

  /** Pitch version playing, in semitones (0 = original). */
  pitch = $state(0);
  /** Pitch version being downloaded/decoded by engine.swap(), if any. */
  pitchSwitching = $state<number | null>(null);
  /** Which pitch versions of the current track the server has rendered. */
  pitchStatus = $state<PitchStatus | null>(null);

  tracks = $state<Track[]>([]);

  view = $state<'drop' | 'status' | 'player'>('drop');

  status = $state<{ stage: string; percent: number; message: string }>({
    stage: '',
    percent: 0,
    message: ''
  });
}

export const app = new AppState();
export const engine = new StemPlayer();

engine.onUpdate = (snap) => {
  app.player = snap;
};

engine.onEnded = () => {
  // pin to 0; the user can press play to restart
  // (engine already paused itself; we just keep the snapshot accurate)
};

export { STEMS, type Stem };
