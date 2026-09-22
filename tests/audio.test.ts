import { describe, expect, it } from 'vitest';
import {
  clipBounds,
  divideFrequency,
  encodeWav,
  inspectFlac,
  MAX_PCM_SAMPLES,
  preparePcm,
  resample,
  waveform,
} from '../src/audio/signal';

function tone(frequency: number, sampleRate: number, seconds: number) {
  return Float32Array.from(
    { length: Math.round(sampleRate * seconds) },
    (_, index) =>
      0.5 * Math.sin((2 * Math.PI * frequency * index) / sampleRate),
  );
}

function rms(values: Float32Array) {
  return Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0) / values.length,
  );
}

function flacHeader(sampleRate: number, samples: number, channels = 1) {
  const bytes = new Uint8Array(42);
  bytes.set([102, 76, 97, 67, 128, 0, 0, 34]);
  new DataView(bytes.buffer).setBigUint64(
    18,
    (BigInt(sampleRate) << 44n) |
      (BigInt(channels - 1) << 41n) |
      (15n << 36n) |
      BigInt(samples),
  );
  return bytes;
}

function upwardCrossingsPerSecond(audio: Float32Array, sampleRate: number) {
  let crossings = 0;
  for (let index = 1; index < audio.length; index++)
    if (audio[index] >= 0 && audio[index - 1] < 0) crossings++;
  return (crossings * sampleRate) / audio.length;
}

describe('real-time frequency division', () => {
  it('keeps a 40 kHz call at its original duration while dividing it to 4 kHz', () => {
    const output = preparePcm(
      { channelData: [tone(40_000, 250_000, 0.05)], sampleRate: 250_000 },
      'realtime',
      null,
      null,
    );
    expect(output.sampleRate).toBe(48_000);
    expect(output.duration).toBeCloseTo(0.05);
    const audio = output.channelData[0].subarray(200, 2_300);
    expect(upwardCrossingsPerSecond(audio, output.sampleRate)).toBeCloseTo(
      4_000,
      -2,
    );
    expect(rms(audio)).toBeGreaterThan(0.2);
  });

  it('stays silent between calls instead of dividing background noise', () => {
    const sampleRate = 250_000;
    const quiet = new Float32Array(sampleRate / 100);
    for (let index = 0; index < quiet.length; index++)
      quiet[index] =
        0.002 * Math.sin((2 * Math.PI * 30_000 * index) / sampleRate);
    const call = tone(40_000, sampleRate, 0.01);
    const input = new Float32Array(quiet.length * 2 + call.length);
    input.set(quiet, 0);
    input.set(call, quiet.length);
    input.set(quiet, quiet.length + call.length);
    const divided = divideFrequency(input, sampleRate);
    expect(rms(divided.subarray(0, quiet.length - 100))).toBe(0);
    expect(
      rms(divided.subarray(quiet.length + 500, quiet.length + call.length)),
    ).toBeGreaterThan(0.2);
    expect(divideFrequency(new Float32Array(1_000), sampleRate)).toEqual(
      new Float32Array(1_000),
    );
  });
});

describe('original-rate audio conversion', () => {
  it('makes 40 kHz bat calls audible at 4 kHz with ten times the duration', () => {
    const output = preparePcm(
      { channelData: [tone(40_000, 250_000, 0.05)], sampleRate: 250_000 },
      'bat',
      null,
      null,
    );
    expect(output.sampleRate).toBe(48_000);
    expect(output.sourceDuration).toBeCloseTo(0.05);
    expect(output.duration).toBeCloseTo(0.5);
    const audio = output.channelData[0].subarray(1_000, 23_000);
    let crossings = 0;
    for (let index = 1; index < audio.length; index++)
      if (audio[index] >= 0 && audio[index - 1] < 0) crossings++;
    expect((crossings * output.sampleRate) / audio.length).toBeCloseTo(
      4_000,
      -1,
    );
    expect(rms(audio)).toBeGreaterThan(0.34);
  });

  it('filters ultrasound instead of aliasing it into natural playback', () => {
    const output = resample(tone(40_000, 250_000, 0.03), 250_000, 48_000);
    expect(rms(output.subarray(100, output.length - 100))).toBeLessThan(0.001);
    const audible = resample(tone(4_000, 250_000, 0.03), 250_000, 48_000);
    expect(rms(audible.subarray(100, audible.length - 100))).toBeGreaterThan(
      0.34,
    );
  });

  it('keeps missing offsets playable and clips valid detections with context', () => {
    expect(clipBounds(480_000, 48_000, null, null)).toEqual({
      start: 0,
      end: 480_000,
    });
    expect(clipBounds(480_000, 48_000, 2, 5)).toEqual({
      start: 79_200,
      end: 256_800,
    });
    expect(clipBounds(480_000, 48_000, 9, 12).end).toBe(480_000);
    for (const [start, end] of [
      [-1, 3],
      [2, 1],
      [10, 12],
      [NaN, 3],
      [1, Infinity],
    ]) {
      expect(() => clipBounds(480_000, 48_000, start, end)).toThrow(
        'invalid recording time range',
      );
    }
  });

  it('rejects oversized, unknown-length, and unsupported inputs before decoding', () => {
    expect(inspectFlac(flacHeader(250_000, 1_500_000))).toEqual({
      sampleRate: 250_000,
      samples: 1_500_000,
      channels: 1,
    });
    expect(() => inspectFlac(flacHeader(250_000, MAX_PCM_SAMPLES + 1))).toThrow(
      'too large',
    );
    expect(() => inspectFlac(flacHeader(48_000, 48_000 * 61))).toThrow(
      'too large',
    );
    expect(() => inspectFlac(flacHeader(250_000, 0))).toThrow(
      'unsupported audio dimensions',
    );
    expect(() => inspectFlac(flacHeader(48_000, 48_000, 3))).toThrow(
      'unsupported audio dimensions',
    );
    expect(() => inspectFlac(new Uint8Array(42))).toThrow(
      'not a supported FLAC',
    );
    expect(() => resample(new Float32Array(48_000), 1, 48_000)).toThrow(
      'too long',
    );
    expect(() =>
      preparePcm(
        { sampleRate: 8_000, channelData: [new Float32Array(8_000 * 13)] },
        'bat',
        null,
        null,
      ),
    ).toThrow('too long');
  });

  it('exports interoperable PCM16 WAV with correct stereo layout and clipped samples', () => {
    const data = encodeWav(
      [new Float32Array([-1, 0.5, NaN]), new Float32Array([1, -2, 0])],
      48_000,
    );
    const view = new DataView(data);
    expect(new TextDecoder().decode(new Uint8Array(data, 0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(new Uint8Array(data, 8, 4))).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(data.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(192_000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(
      Array.from({ length: 6 }, (_, index) =>
        view.getInt16(44 + index * 2, true),
      ),
    ).toEqual([-32768, 32767, 16384, -32768, 0, 0]);
    expect(waveform([new Float32Array(100)])).toEqual(new Array(80).fill(0));
  });

  it('draws the calls above the noise floor instead of a flat picket fence', () => {
    const sampleRate = 48_000;
    const noise = Float32Array.from({ length: sampleRate }, (_, index) =>
      index % 7 === 0 ? 0.3 : 0.05 * Math.sin(index),
    );
    const call = tone(2_000, sampleRate, 0.25);
    for (let index = 0; index < call.length; index++)
      noise[sampleRate / 2 + index] += call[index];
    const bars = waveform([noise], 8);
    expect(bars).toHaveLength(8);
    expect(Math.max(...bars)).toBe(1);
    expect(Math.min(...bars.slice(0, 4))).toBeLessThan(0.15);
    expect(Math.min(...bars.slice(4, 6))).toBeGreaterThan(0.9);
    expect(
      waveform([Float32Array.from({ length: 800 }, () => 0.5)], 4),
    ).toEqual([1, 1, 1, 1]);
  });
});
