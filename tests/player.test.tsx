// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareAudio } from '../src/audio';
import { usePlayer, type Player } from '../src/usePlayer';
import type { PreparedAudio, Recording } from '../src/types';

vi.mock('../src/audio', () => ({ prepareAudio: vi.fn() }));
vi.mock('../src/telemetry', () => ({ reportError: vi.fn() }));

const prepare = vi.mocked(prepareAudio);
const recording: Recording = {
  id: '101',
  timestamp: '2026-09-21T01:00:00Z',
  commonName: 'Eastern Red Bat',
  scientificName: 'Lasiurus borealis',
  speciesId: '42',
  classification: 'bat',
  confidence: 0.9,
  imageUrl: null,
  imageCredit: null,
  imageLicense: null,
  imageLicenseUrl: null,
  imageSource: null,
  behavior: null,
  audioUrl: 'https://media.birdweather.com/soundscapes/test.flac',
  startTime: null,
  endTime: null,
};

function prepared(duration: number): PreparedAudio {
  return {
    blob: new Blob(['audio'], { type: 'audio/wav' }),
    duration,
    sourceDuration: 1,
    sampleRate: 48_000,
    waveform: [0.5],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

let player: Player;
let root: Root;
let container: HTMLDivElement;

function Harness() {
  player = usePlayer();
  return <audio ref={player.audioRef} {...player.audioEvents} />;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  prepare.mockReset();
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    () => `blob:prepared-${++nextUrl}`,
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event('pause'));
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('player request lifecycle', () => {
  it('resumes prepared bat audio and discards a pending natural-mode result', async () => {
    const bat = prepared(10);
    prepare.mockResolvedValueOnce(bat);
    await act(async () => {
      await player.listen(recording);
    });
    await act(async () => {
      player.seek(3.5);
    });
    const originalSource = player.audioRef.current!.src;

    const natural = deferred<PreparedAudio>();
    prepare.mockReturnValueOnce(natural.promise);
    let pendingNatural!: Promise<void>;
    await act(async () => {
      pendingNatural = player.listen(undefined, 'natural');
    });
    const pendingSignal = prepare.mock.calls[1][2]!;
    expect(player.loading).toBe(true);
    expect(player.prepared).toBeNull();

    await act(async () => {
      await player.listen(undefined, 'bat');
    });
    expect(pendingSignal.aborted).toBe(true);
    expect(player.mode).toBe('bat');
    expect(player.prepared).toBe(bat);
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(true);
    expect(player.time).toBe(3.5);
    expect(player.audioRef.current!.src).toBe(originalSource);

    await act(async () => {
      natural.resolve(prepared(1));
      await pendingNatural;
    });
    expect(player.mode).toBe('bat');
    expect(player.prepared).toBe(bat);
    expect(player.audioRef.current!.src).toBe(originalSource);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('keeps a newly selected recording when the previous request finishes late', async () => {
    const oldRequest = deferred<PreparedAudio>();
    const newRequest = deferred<PreparedAudio>();
    prepare
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    let oldListen!: Promise<void>;
    await act(async () => {
      oldListen = player.listen(recording);
    });
    const oldSignal = prepare.mock.calls[0][2]!;

    const nextRecording: Recording = {
      ...recording,
      id: '102',
      classification: 'bird',
      commonName: 'Northern Cardinal',
    };
    let newListen!: Promise<void>;
    await act(async () => {
      newListen = player.listen(nextRecording);
    });
    expect(oldSignal.aborted).toBe(true);
    expect(player.recording).toBe(nextRecording);
    expect(player.mode).toBe('natural');
    expect(player.loading).toBe(true);

    await act(async () => {
      oldRequest.resolve(prepared(10));
      await oldListen;
    });
    expect(player.recording).toBe(nextRecording);
    expect(player.prepared).toBeNull();
    expect(player.loading).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    const nextAudio = prepared(2);
    await act(async () => {
      newRequest.resolve(nextAudio);
      await newListen;
    });
    expect(player.prepared).toBe(nextAudio);
    expect(player.recording).toBe(nextRecording);
    expect(player.mode).toBe('natural');
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(nextAudio.blob);
  });
});
