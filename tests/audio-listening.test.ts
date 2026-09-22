import { describe, expect, it } from 'vitest';
import { normalizeListening, pcmLevels } from '../src/audio/listening';
import {
  encodeWav,
  MAX_OUTPUT_SECONDS,
  OUTPUT_SAMPLE_RATE,
  resample,
} from '../src/audio/signal';
import { createSpectrogram } from '../src/audio/spectrogram';

function tone(amplitude: number) {
  return Float32Array.from(
    { length: 4_800 },
    (_, index) => amplitude * Math.sin((2 * Math.PI * index) / 12),
  );
}

describe('listening volume', () => {
  it('raises a quiet bird call to audible PCM16 levels without changing its source spectrum', () => {
    const source = tone(0.001);
    const original = source.slice();
    const spectrum = createSpectrogram([source], 48_000);
    const output = normalizeListening([source]);
    const levels = pcmLevels(output.channelData);
    expect(20 * Math.log10(levels.peak)).toBeCloseTo(-3, 4);
    expect(20 * Math.log10(levels.rms)).toBeCloseTo(-6.01, 2);
    expect(output.listeningGainDb).toBeCloseTo(57, 4);
    expect(source).toEqual(original);
    expect(output.channelData[0]).not.toBe(source);
    expect(createSpectrogram([source], 48_000)).toEqual(spectrum);
    const wav = new DataView(encodeWav(output.channelData, 48_000));
    expect(wav.getInt16(44 + 3 * 2, true)).toBeGreaterThan(23_000);
  });

  it('uses one linear gain for both stereo channels and caps the boost at 60 dB', () => {
    const left = tone(0.00006);
    const right = left.map((sample) => sample * -0.5);
    const output = normalizeListening([left, right]);
    expect(output.listeningGainDb).toBe(60);
    expect(pcmLevels(output.channelData).peak).toBeCloseTo(0.06, 6);
    for (let index = 0; index < left.length; index++) {
      expect(output.channelData[1][index]).toBeCloseTo(
        output.channelData[0][index] * -0.5,
        7,
      );
    }
  });

  it('leaves silence, DC offsets, and near-floor noise unamplified', () => {
    const inputs = [
      new Float32Array(4_800),
      new Float32Array(4_800).fill(0.1),
      Float32Array.from(
        { length: 4_800 },
        (_, index) => (((index * 7919) % 65521) / 65521 - 0.5) * 0.00002,
      ),
      tone(0.00001).map((sample) => sample + 0.1),
    ];
    for (const input of inputs) {
      const output = normalizeListening([input]);
      expect(output.listeningGainDb).toBe(0);
      expect(output.channelData[0]).toBe(input);
    }
  });

  it('attenuates loud samples and resampling overshoots instead of clipping', () => {
    for (const amplitude of [0.9, 1.3]) {
      const output = normalizeListening([tone(amplitude)]);
      expect(output.listeningGainDb).toBeLessThan(0);
      expect(pcmLevels(output.channelData).peak).toBeCloseTo(10 ** (-3 / 20));
      const wav = new DataView(encodeWav(output.channelData, 48_000));
      for (let offset = 44; offset < wav.byteLength; offset += 2) {
        expect(Math.abs(wav.getInt16(offset, true))).toBeLessThan(23_200);
      }
    }
  });

  it('keeps rejected ultrasound below the audible floor in natural playback', () => {
    const source = Float32Array.from(
      { length: 25_000 },
      (_, index) => 0.5 * Math.sin((2 * Math.PI * 40_000 * index) / 250_000),
    );
    const natural = resample(source, 250_000, 48_000);
    const listening = normalizeListening([natural]);
    const interior = listening.channelData[0].subarray(100, 4_700);
    expect(pcmLevels([interior]).rms).toBeLessThan(0.00001);
  });

  it('rejects nonfinite samples and invalid dimensions before allocating output', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => normalizeListening([new Float32Array([0, value])])).toThrow(
        'invalid audio samples',
      );
    }
    for (const channels of [
      [],
      [new Float32Array()],
      [new Float32Array(1), new Float32Array(2)],
      Array.from({ length: 3 }, () => new Float32Array(1)),
      [new Float32Array(OUTPUT_SAMPLE_RATE * MAX_OUTPUT_SECONDS + 1)],
    ]) {
      expect(() => normalizeListening(channels)).toThrow('dimensions');
    }
  });
});
