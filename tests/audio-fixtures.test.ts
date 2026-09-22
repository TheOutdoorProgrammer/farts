import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeRecording } from '../src/audio/prepare';

const fixtures = process.env.BETTERBIRDS_AUDIO_FIXTURES;

function wavLevels(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  let peak = 0;
  let squares = 0;
  for (let offset = 44; offset < buffer.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true) / 32768;
    peak = Math.max(peak, Math.abs(sample));
    squares += sample * sample;
  }
  return {
    peakDb: 20 * Math.log10(peak),
    rmsDb: 10 * Math.log10(squares / ((buffer.byteLength - 44) / 2)),
  };
}

describe.skipIf(!fixtures)('real BirdWeather audio fixtures', () => {
  it('decodes and exports a bird detection', async () => {
    const audio = await decodeRecording(
      new Uint8Array(await readFile(`${fixtures}/bird.flac`)),
      { mode: 'natural', startTime: 6, endTime: 9 },
    );
    expect(audio.sampleRate).toBe(48_000);
    expect(audio.duration).toBeCloseTo(3.35);
    expect(audio.waveform.some((value) => value > 0)).toBe(true);
    expect(audio.spectrogram.duration).toBeCloseTo(audio.sourceDuration);
    expect(audio.spectrogram.maxFrequency).toBe(24_000);
    expect(audio.spectrogram.data.some((value) => value > 0)).toBe(true);
    expect(audio.listeningGainDb).toBeGreaterThan(50);
    expect(wavLevels(audio.wav).peakDb).toBeCloseTo(-3, 2);
    expect(wavLevels(audio.wav).rmsDb).toBeGreaterThan(-20);
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
    expect(audio.spectrogram.duration).toBeCloseTo(audio.sourceDuration);
    expect(audio.spectrogram.maxFrequency).toBe(125_000);
    expect(audio.spectrogram.data.some((value) => value > 0)).toBe(true);
    expect(audio.listeningGainDb).toBeGreaterThan(25);
    expect(wavLevels(audio.wav).peakDb).toBeCloseTo(-3, 2);
    expect(wavLevels(audio.wav).rmsDb).toBeGreaterThan(-42);
    await writeFile(`${fixtures}/bat.wav`, new Uint8Array(audio.wav));
  }, 30_000);

  it.skipIf(!existsSync(`${fixtures}/production-vesper.flac`))(
    'exports audible production Vesper Bat pulses',
    async () => {
      const audio = await decodeRecording(
        new Uint8Array(await readFile(`${fixtures}/production-vesper.flac`)),
        { mode: 'bat', startTime: null, endTime: null },
      );
      expect(audio.listeningGainDb).toBeGreaterThan(20);
      expect(wavLevels(audio.wav).peakDb).toBeCloseTo(-3, 2);
      expect(wavLevels(audio.wav).rmsDb).toBeGreaterThan(-45);
      expect(audio.spectrogram.maxFrequency).toBe(125_000);
      expect(audio.duration).toBeCloseTo(audio.sourceDuration * 10);
      await writeFile(
        `${fixtures}/production-vesper.wav`,
        new Uint8Array(audio.wav),
      );
    },
    30_000,
  );

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
