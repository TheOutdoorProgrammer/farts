import { describe, expect, it } from 'vitest';
import { createSpectrogram } from '../src/audio/spectrogram';
import type { Spectrogram } from '../src/types';

function tone(
  frequency: number,
  sampleRate: number,
  seconds: number,
  amplitude = 0.5,
) {
  return Float32Array.from(
    { length: Math.round(sampleRate * seconds) },
    (_, index) =>
      amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate),
  );
}

function strongestFrequency(spectrogram: Spectrogram) {
  const totals = new Float64Array(spectrogram.height);
  for (let column = 0; column < spectrogram.width; column++)
    for (let row = 0; row < spectrogram.height; row++)
      totals[row] += spectrogram.data[column * spectrogram.height + row];
  let strongest = 0;
  for (let row = 1; row < totals.length; row++)
    if (totals[row] > totals[strongest]) strongest = row;
  return (strongest * spectrogram.maxFrequency) / (spectrogram.height - 1);
}

function peakDecibels(spectrogram: Spectrogram) {
  let peak = 0;
  for (const value of spectrogram.data) peak = Math.max(peak, value);
  return (
    spectrogram.minDecibels +
    (peak / 255) * (spectrogram.maxDecibels - spectrogram.minDecibels)
  );
}

describe('original-rate spectrogram', () => {
  it('locates a 1 kHz bird tone on the calibrated frequency axis', () => {
    const result = createSpectrogram([tone(1_000, 48_000, 0.2)], 48_000);
    expect(Math.abs(strongestFrequency(result) - 1_000)).toBeLessThan(100);
    expect(result.maxFrequency).toBe(24_000);
    expect(result.duration).toBeCloseTo(0.2);
    expect(result.data.length).toBe(result.width * result.height);
  });

  it('keeps 40 kHz bat ultrasound at its original frequency', () => {
    const result = createSpectrogram([tone(40_000, 250_000, 0.06)], 250_000);
    expect(Math.abs(strongestFrequency(result) - 40_000)).toBeLessThan(500);
    expect(result.maxFrequency).toBe(125_000);
    expect(result.duration).toBeCloseTo(0.06);
    expect(result.width).toBeLessThanOrEqual(768);
    expect(result.height).toBeLessThanOrEqual(256);
  });

  it('uses fixed dBFS with coherent window gain, not per-recording normalization', () => {
    const full = createSpectrogram([tone(3_000, 48_000, 0.1, 1)], 48_000);
    const quiet = createSpectrogram([tone(3_000, 48_000, 0.1, 0.1)], 48_000);
    expect(full.minDecibels).toBe(-90);
    expect(full.maxDecibels).toBe(0);
    expect(peakDecibels(full)).toBeCloseTo(0, 1);
    expect(peakDecibels(quiet)).toBeCloseTo(-20, 0);
  });

  it('includes DC and Nyquist without doubling their amplitude', () => {
    const dc = createSpectrogram([new Float32Array(4_096).fill(0.5)], 48_000);
    const nyquist = createSpectrogram(
      [
        Float32Array.from({ length: 4_096 }, (_, index) =>
          index % 2 ? -0.5 : 0.5,
        ),
      ],
      48_000,
    );
    const middle = Math.floor(dc.width / 2) * dc.height;
    const dcLevel = -90 + (dc.data[middle] / 255) * 90;
    const nyquistLevel =
      -90 + (nyquist.data[middle + nyquist.height - 1] / 255) * 90;
    expect(dcLevel).toBeCloseTo(20 * Math.log10(0.5), 0);
    expect(nyquistLevel).toBeCloseTo(dcLevel, 1);
    expect(strongestFrequency(nyquist)).toBe(24_000);
  });

  it('retains opposite-phase stereo and signals present in only one channel', () => {
    const input = tone(6_000, 48_000, 0.1);
    const mono = createSpectrogram([input], 48_000);
    const antiphase = createSpectrogram(
      [input, input.map((value) => -value)],
      48_000,
    );
    const oneChannel = createSpectrogram(
      [new Float32Array(input.length), input],
      48_000,
    );
    expect(antiphase.data).toEqual(mono.data);
    expect(oneChannel.data).toEqual(mono.data);
  });

  it('represents silence and nonfinite samples as the noise floor', () => {
    const input = new Float32Array(2_048);
    input[40] = NaN;
    input[800] = Infinity;
    input[1_800] = -Infinity;
    const result = createSpectrogram(
      [input, new Float32Array(input.length)],
      48_000,
    );
    expect(result.data.every((value) => value === 0)).toBe(true);
  });

  it('analyzes short input and the recording boundaries with zero padding', () => {
    const single = createSpectrogram([new Float32Array([1])], 48_000);
    expect(single.width).toBe(1);
    expect(single.duration).toBe(1 / 48_000);
    expect(single.data.some((value) => value > 0)).toBe(true);
    const edges = new Float32Array(20_000);
    edges[0] = 1;
    edges[edges.length - 1] = 1;
    const result = createSpectrogram([edges], 250_000);
    expect(
      result.data.subarray(0, result.height).some((value) => value > 0),
    ).toBe(true);
    expect(
      result.data.subarray(-result.height).some((value) => value > 0),
    ).toBe(true);
  });

  it('preserves brief pulses throughout a compressed time axis without sampling gaps', () => {
    const input = new Float32Array(1_000_000);
    const starts = [100, 19_973, 277_777, 650_001, 999_500];
    for (const start of starts) input.set(tone(40_000, 250_000, 0.001), start);
    const result = createSpectrogram([input], 250_000);
    expect(result.width).toBe(768);
    const row = Math.round(
      (40_000 / result.maxFrequency) * (result.height - 1),
    );
    for (const start of starts) {
      const column = Math.floor((start / input.length) * result.width);
      let peak = 0;
      for (
        let x = Math.max(0, column - 2);
        x <= Math.min(result.width - 1, column + 2);
        x++
      )
        for (let y = row - 1; y <= row + 1; y++)
          peak = Math.max(peak, result.data[x * result.height + y]);
      expect(peak).toBeGreaterThan(150);
    }
  });

  it('analyzes six seconds at 250 kHz within bounded output dimensions', () => {
    const result = createSpectrogram([tone(40_000, 250_000, 6)], 250_000);
    expect(result.width).toBe(768);
    expect(result.height).toBe(256);
    expect(result.data.byteLength).toBe(768 * 256);
    expect(result.duration).toBe(6);
    expect(Math.abs(strongestFrequency(result) - 40_000)).toBeLessThan(500);
  });

  it('rejects invalid dimensions before allocating transform buffers', () => {
    for (const [channels, rate] of [
      [[], 48_000],
      [[new Float32Array()], 48_000],
      [[new Float32Array(1), new Float32Array(2)], 48_000],
      [[new Float32Array(1)], NaN],
      [[new Float32Array(1)], 500_000],
      [[new Float32Array(8_000 * 61)], 8_000],
      [[new Float32Array(1), new Float32Array(1), new Float32Array(1)], 48_000],
    ] as [Float32Array[], number][]) {
      expect(() => createSpectrogram(channels, rate)).toThrow('dimensions');
    }
  });
});
