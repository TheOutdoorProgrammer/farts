import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeRecording } from '../src/audio/prepare';

const fixtures = process.env.BETTERBIRDS_AUDIO_FIXTURES;

describe.skipIf(!fixtures)('real BirdWeather audio fixtures', () => {
  it('decodes and exports a bird detection', async () => {
    const audio = await decodeRecording(
      new Uint8Array(await readFile(`${fixtures}/bird.flac`)),
      { mode: 'natural', startTime: 6, endTime: 9 },
    );
    expect(audio.sampleRate).toBe(48_000);
    expect(audio.duration).toBeCloseTo(3.35);
    expect(audio.waveform.some((value) => value > 0)).toBe(true);
    await writeFile(`${fixtures}/bird.wav`, new Uint8Array(audio.wav));
  }, 30_000);

  it('preserves the ultrasonic recording through 10x bat playback', async () => {
    const audio = await decodeRecording(
      new Uint8Array(await readFile(`${fixtures}/bat.flac`)),
      { mode: 'bat', startTime: null, endTime: null },
    );
    expect(audio.sampleRate).toBe(48_000);
    expect(audio.duration).toBeCloseTo(audio.sourceDuration * 10);
    expect(audio.sourceDuration).toBeCloseTo(6, 0);
    expect(audio.waveform.some((value) => value > 0)).toBe(true);
    await writeFile(`${fixtures}/bat.wav`, new Uint8Array(audio.wav));
  }, 30_000);

  it('stops decoding when a file understates its sample count', async () => {
    const bytes = new Uint8Array(await readFile(`${fixtures}/bird.flac`));
    const view = new DataView(bytes.buffer);
    view.setBigUint64(18, (view.getBigUint64(18) & ~0xfffffffffn) | 1n);
    await expect(
      decodeRecording(bytes, {
        mode: 'natural',
        startTime: null,
        endTime: null,
      }),
    ).rejects.toThrow('incomplete or damaged');
  });
});
