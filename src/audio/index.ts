import type { ListeningMode, PreparedAudio, Recording } from '../types';
import type { AudioRequest, AudioResponse } from './protocol';

interface Job {
  request: AudioRequest;
  signal?: AbortSignal;
  resolve: (audio: PreparedAudio) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

const pending: Job[] = [];
let running: Job | null = null;
let worker: Worker | null = null;
let timeout: ReturnType<typeof setTimeout> | undefined;

function finish(job: Job, error?: unknown, result?: PreparedAudio) {
  job.signal?.removeEventListener('abort', job.abort);
  if (running === job) {
    worker?.terminate();
    worker = null;
    running = null;
    clearTimeout(timeout);
  } else {
    const index = pending.indexOf(job);
    if (index >= 0) pending.splice(index, 1);
  }
  if (result) job.resolve(result);
  else job.reject(error);
  startNext();
}

function startNext() {
  if (running || !pending.length) return;
  const job = pending.shift()!;
  running = job;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<AudioResponse>) => {
      if (running !== job) return;
      const response = event.data;
      if (!response.ok) return finish(job, new Error(response.message));
      finish(job, undefined, {
        blob: new Blob([response.wav], { type: 'audio/wav' }),
        duration: response.duration,
        sourceDuration: response.sourceDuration,
        sampleRate: response.sampleRate,
        waveform: response.waveform,
      });
    };
    worker.onerror = () =>
      finish(
        job,
        new Error(
          'Your browser could not prepare this recording. Reload and try again.',
        ),
      );
    worker.onmessageerror = () =>
      finish(
        job,
        new Error('The audio worker returned an unreadable recording.'),
      );
    timeout = setTimeout(
      () =>
        finish(
          job,
          new Error(
            'Preparing audio took too long. Check your connection and try again.',
          ),
        ),
      60_000,
    );
    worker.postMessage(job.request);
  } catch (error) {
    finish(job, error);
  }
}

export async function prepareAudio(
  recording: Recording,
  mode: ListeningMode,
  signal?: AbortSignal,
): Promise<PreparedAudio> {
  signal?.throwIfAborted();
  if (!recording.audioUrl)
    throw new Error('BirdWeather did not provide audio for this detection.');
  if (pending.length >= 3)
    throw new Error(
      'Several recordings are already loading. Try again when one finishes.',
    );
  return new Promise((resolve, reject) => {
    const job: Job = {
      request: {
        audioUrl: recording.audioUrl!,
        startTime: recording.startTime,
        endTime: recording.endTime,
        mode,
      },
      signal,
      resolve,
      reject,
      abort: () =>
        finish(
          job,
          signal?.reason ??
            new DOMException('Audio preparation cancelled.', 'AbortError'),
        ),
    };
    signal?.addEventListener('abort', job.abort, { once: true });
    pending.push(job);
    startNext();
  });
}
