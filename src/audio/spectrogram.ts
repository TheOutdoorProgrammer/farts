import type { Spectrogram } from '../types';
import { MAX_PCM_SAMPLES, MAX_SOURCE_SECONDS } from './signal';

const FFT_SIZE = 1024;
const HOP = FFT_SIZE / 4;
const HEIGHT = 256;
const MAX_WIDTH = 768;
const MIN_DECIBELS = -90;
const MAX_DECIBELS = 0;

const window = new Float64Array(FFT_SIZE);
const reversed = new Uint16Array(FFT_SIZE);
const cosine = new Float64Array(FFT_SIZE / 2);
const sine = new Float64Array(FFT_SIZE / 2);
let windowSum = 0;
for (let index = 0; index < FFT_SIZE; index++) {
  window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / FFT_SIZE);
  windowSum += window[index];
  let source = index;
  for (let bit = FFT_SIZE; bit > 1; bit /= 2) {
    reversed[index] = (reversed[index] << 1) | (source & 1);
    source >>= 1;
  }
  if (index < FFT_SIZE / 2) {
    cosine[index] = Math.cos((2 * Math.PI * index) / FFT_SIZE);
    sine[index] = -Math.sin((2 * Math.PI * index) / FFT_SIZE);
  }
}

// Radix-2 DIT, with input already bit-reversed:
// https://www.dsprelated.com/freebooks/mdft/Radix_2_FFT.html
function transform(real: Float64Array, imaginary: Float64Array) {
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const stride = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let offset = 0; offset < half; offset++) {
        const even = start + offset;
        const odd = even + half;
        const angle = offset * stride;
        const re = cosine[angle] * real[odd] - sine[angle] * imaginary[odd];
        const im = cosine[angle] * imaginary[odd] + sine[angle] * real[odd];
        real[odd] = real[even] - re;
        imaginary[odd] = imaginary[even] - im;
        real[even] += re;
        imaginary[even] += im;
      }
    }
  }
}

export function createSpectrogram(
  channelData: Float32Array[],
  sampleRate: number,
): Spectrogram {
  const samples = channelData[0]?.length ?? 0;
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 384_000 ||
    channelData.length < 1 ||
    channelData.length > 2 ||
    samples < 1 ||
    samples * channelData.length > MAX_PCM_SAMPLES ||
    samples / sampleRate > MAX_SOURCE_SECONDS ||
    channelData.some((channel) => channel.length !== samples)
  ) {
    throw new Error('Unsupported spectrogram audio dimensions.');
  }

  const frames = Math.ceil(samples / HOP);
  const width = Math.min(MAX_WIDTH, frames);
  const peaks = new Float32Array(width * HEIGHT);
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  const normalization = 1 / (windowSum * windowSum);
  const nyquistBin = FFT_SIZE / 2;

  for (const channel of channelData) {
    for (let frame = 0; frame < frames; frame++) {
      const start = frame * HOP - FFT_SIZE / 2;
      imaginary.fill(0);
      for (let index = 0; index < FFT_SIZE; index++) {
        const source = start + index;
        const value = source >= 0 && source < samples ? channel[source] : 0;
        real[reversed[index]] = Number.isFinite(value)
          ? value * window[index]
          : 0;
      }
      transform(real, imaginary);
      const column = Math.floor((frame * width) / frames) * HEIGHT;
      for (let bin = 0; bin <= nyquistBin; bin++) {
        // Hann coherent gain and one-sided amplitude scaling, excluding DC/Nyquist:
        // https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.ShortTimeFFT.fft_mode.html
        const scale = bin === 0 || bin === nyquistBin ? 1 : 4;
        const power =
          (real[bin] * real[bin] + imaginary[bin] * imaginary[bin]) *
          normalization *
          scale;
        const row = Math.round((bin * (HEIGHT - 1)) / nyquistBin);
        // Max aggregation preserves short pulses and avoids opposite-phase channel cancellation.
        if (power > peaks[column + row]) peaks[column + row] = power;
      }
    }
  }

  const data = new Uint8Array(peaks.length);
  for (let index = 0; index < peaks.length; index++) {
    const decibels = 10 * Math.log10(peaks[index]);
    data[index] = Math.round(
      255 *
        Math.max(
          0,
          Math.min(
            1,
            (decibels - MIN_DECIBELS) / (MAX_DECIBELS - MIN_DECIBELS),
          ),
        ),
    );
  }
  return {
    width,
    height: HEIGHT,
    data,
    maxFrequency: sampleRate / 2,
    duration: samples / sampleRate,
    minDecibels: MIN_DECIBELS,
    maxDecibels: MAX_DECIBELS,
  };
}
