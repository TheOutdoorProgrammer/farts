// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFeed } from '../src/api';
import { prepareAudio } from '../src/audio';
import { RecordingFeed } from '../src/RecordingFeed';
import { usePlayer } from '../src/usePlayer';
import { readRoute } from '../src/useRoute';
import type { PreparedAudio, Recording } from '../src/types';

vi.mock('../src/api', () => ({ fetchFeed: vi.fn() }));
vi.mock('../src/audio', () => ({ prepareAudio: vi.fn() }));
vi.mock('../src/telemetry', () => ({ reportError: vi.fn() }));

const recording: Recording = {
  id: '101',
  timestamp: '2026-09-21T01:00:00Z',
  commonName: 'Eastern Red Bat',
  scientificName: 'Lasiurus borealis',
  speciesId: '42',
  classification: 'bat',
  confidence: 0.9,
  imageUrl: '/media/bat-photo',
  imageCredit: 'Wildlife photographer',
  imageSource: 'https://example.org/photo',
  imageLicense: 'CC BY 2.0',
  imageLicenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
  behavior: null,
  audioUrl: '/media/bat-recording',
  startTime: null,
  endTime: null,
};
const prepared: PreparedAudio = {
  blob: new Blob(['audio'], { type: 'audio/wav' }),
  duration: 60,
  sourceDuration: 6,
  sampleRate: 48_000,
  listeningGainDb: 30,
  waveform: [0.1, 0.5, 1, 0.2],
  spectrogram: {
    width: 2,
    height: 2,
    data: new Uint8Array([50, 100, 150, 200]),
    maxFrequency: 125_000,
    duration: 6,
    minDecibels: -90,
    maxDecibels: 0,
  },
};
let root: Root;
let container: HTMLDivElement;

function Harness() {
  const player = usePlayer();
  return (
    <>
      <RecordingFeed
        route={readRoute()}
        navigate={vi.fn()}
        player={player}
        onShare={vi.fn()}
      />
      <audio ref={player.audioRef} {...player.audioEvents} />
    </>
  );
}

async function click(selector: string) {
  const element = container.querySelector<HTMLButtonElement>(selector);
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', '/');
  vi.mocked(fetchFeed).mockResolvedValue({
    station: { id: '30605', name: 'StoutBats', timezone: 'UTC' },
    recordings: [
      recording,
      { ...recording, id: '102', commonName: 'Vesper Bats' },
    ],
    nextCursor: null,
    fetchedAt: recording.timestamp,
  });
  vi.mocked(prepareAudio).mockResolvedValue(prepared);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:prepared');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
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
  await act(async () => root.render(<Harness />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('listening from the field journal', () => {
  it('shows credited animal photos and clip URLs without loading audio until selected', () => {
    expect(container.querySelector('.player-card')).toBeNull();
    expect(prepareAudio).not.toHaveBeenCalled();
    expect(container.querySelector('.row-play img')?.getAttribute('src')).toBe(
      recording.imageUrl,
    );
    expect(container.querySelector('.photo-credit')?.textContent).toContain(
      recording.imageCredit,
    );
    expect(
      container.querySelector('.photo-credit a')?.getAttribute('href'),
    ).toBe(recording.imageSource);
    expect(
      container.querySelector('.recording-link')?.getAttribute('href'),
    ).toBe('/recordings/101');
    expect(container.querySelector('button a')).toBeNull();
  });

  it('opens the player inside the clicked recording and moves it when another is selected', async () => {
    await click('.recording-item:nth-child(2) .recording-title');
    expect(
      container.querySelector('.recording-item:nth-child(1) .player-card'),
    ).toBeNull();
    expect(
      container.querySelector('.recording-item:nth-child(2) .player-card h2')
        ?.textContent,
    ).toBe('Vesper Bats');
    expect(container.querySelectorAll('.player-card')).toHaveLength(1);
    expect(container.querySelector('.player-card')?.textContent).toContain(
      'Listening volume boosted',
    );
    await click('.recording-item:nth-child(1) .row-play');
    expect(
      container.querySelector('.recording-item:nth-child(1) .player-card h2')
        ?.textContent,
    ).toBe('Eastern Red Bat');
    expect(
      container.querySelector('.recording-item:nth-child(2) .player-card'),
    ).toBeNull();
  });

  it('scrubs the audio and visible playhead through the active visualization only', async () => {
    await click('.recording-title');
    for (const label of ['Spectrogram position', 'Waveform position']) {
      if (label.startsWith('Waveform'))
        await click('.visualization-controls button:nth-child(2)');
      const slider = container.querySelector<HTMLInputElement>(
        'input[type="range"]',
      )!;
      expect(container.querySelectorAll('input[type="range"]')).toHaveLength(1);
      expect(slider.getAttribute('aria-label')).toBe(label);
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(slider, '30');
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.querySelector('audio')!.currentTime).toBe(30);
      expect(
        container.querySelector<HTMLElement>('.visualization-playhead')!.style
          .left,
      ).toBe('50%');
      expect(container.querySelector('.playback-time input')).toBeNull();
      expect(slider.disabled).toBe(false);
    }
  });
});
