import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recording } from '../src/types';
import { prepareAudio } from '../src/audio';

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    TestWorker.instances.push(this);
  }
  succeed() {
    this.onmessage?.({
      data: {
        ok: true,
        wav: new ArrayBuffer(44),
        duration: 1,
        sourceDuration: 1,
        sampleRate: 48_000,
        waveform: [1],
      },
    });
  }
}

const recording = {
  audioUrl: 'https://media.birdweather.com/soundscapes/30605/test.flac',
  startTime: null,
  endTime: null,
} as Recording;

beforeEach(() => {
  TestWorker.instances = [];
  vi.stubGlobal('Worker', TestWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('audio worker lifecycle', () => {
  it('serializes work and terminates completed workers', async () => {
    const first = prepareAudio(recording, 'natural');
    const second = prepareAudio(recording, 'bat');
    expect(TestWorker.instances).toHaveLength(1);
    TestWorker.instances[0].succeed();
    expect((await first).blob.type).toBe('audio/wav');
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(TestWorker.instances).toHaveLength(2);
    TestWorker.instances[1].succeed();
    await second;
  });

  it('cancels queued work immediately and terminates active decoding on abort', async () => {
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const first = prepareAudio(recording, 'natural', firstController.signal);
    const queued = prepareAudio(recording, 'natural', queuedController.signal);
    const queuedResult = expect(queued).rejects.toMatchObject({
      name: 'AbortError',
    });
    queuedController.abort();
    await queuedResult;
    expect(TestWorker.instances).toHaveLength(1);
    const firstResult = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    firstController.abort();
    await firstResult;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it('bounds pending work and does not fetch absent audio', async () => {
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const jobs = controllers.map((controller) =>
      prepareAudio(recording, 'natural', controller.signal).catch(
        (error) => error,
      ),
    );
    await expect(prepareAudio(recording, 'natural')).rejects.toThrow(
      'already loading',
    );
    for (const controller of controllers) controller.abort();
    await Promise.all(jobs);
    await expect(
      prepareAudio({ ...recording, audioUrl: null }, 'natural'),
    ).rejects.toThrow('did not provide audio');
  });

  it('releases a hung worker after the preparation deadline', async () => {
    vi.useFakeTimers();
    const job = prepareAudio(recording, 'natural');
    const result = expect(job).rejects.toThrow('took too long');
    vi.advanceTimersByTime(60_000);
    await result;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
});
