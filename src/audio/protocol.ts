import type { ListeningMode } from '../types';

export interface AudioRequest {
  audioUrl: string;
  startTime: number | null;
  endTime: number | null;
  mode: ListeningMode;
}

export type AudioResponse =
  | {
      ok: true;
      wav: ArrayBuffer;
      duration: number;
      sourceDuration: number;
      sampleRate: number;
      waveform: number[];
    }
  | { ok: false; message: string };
