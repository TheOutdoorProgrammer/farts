export const OUTPUT_SAMPLE_RATE = 48_000;
export const MAX_SOURCE_SECONDS = 60;
export const MAX_OUTPUT_SECONDS = 120;
export const MAX_PCM_SAMPLES = 8_000_000;
export const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024;

export interface PcmAudio {
  channelData: Float32Array[];
  sampleRate: number;
}

export function inspectFlac(bytes: Uint8Array) {
  if (
    bytes.length < 42 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC'
  ) {
    throw new Error('This recording is not a supported FLAC audio file.');
  }
  if (
    (bytes[4] & 0x7f) !== 0 ||
    bytes[5] !== 0 ||
    bytes[6] !== 0 ||
    bytes[7] !== 34
  ) {
    throw new Error('The recording has invalid FLAC metadata.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packed = view.getBigUint64(18);
  const sampleRate = Number(packed >> 44n);
  const channels = Number((packed >> 41n) & 7n) + 1;
  const samples = Number(packed & 0xfffffffffn);
  validateDimensions(sampleRate, channels, samples);
  return { sampleRate, channels, samples };
}

function validateDimensions(
  sampleRate: number,
  channels: number,
  samples: number,
) {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 384_000 ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 2 ||
    !Number.isInteger(samples) ||
    samples <= 0
  ) {
    throw new Error('The recording has unsupported audio dimensions.');
  }
  if (
    samples * channels > MAX_PCM_SAMPLES ||
    samples / sampleRate > MAX_SOURCE_SECONDS
  ) {
    throw new Error(
      'This recording is too large to prepare safely on your device.',
    );
  }
}

export function clipBounds(
  samples: number,
  sampleRate: number,
  start: number | null,
  end: number | null,
) {
  if (start === null || end === null) return { start: 0, end: samples };
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    start >= samples / sampleRate
  ) {
    throw new Error('BirdWeather returned an invalid recording time range.');
  }
  return {
    start: Math.max(0, Math.floor((start - 0.35) * sampleRate)),
    end: Math.min(samples, Math.ceil((end + 0.35) * sampleRate)),
  };
}

export function resample(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (
    input.length === 0 ||
    !Number.isFinite(sourceRate) ||
    sourceRate <= 0 ||
    !Number.isFinite(targetRate) ||
    targetRate <= 0
  )
    throw new Error('Invalid audio resampling input.');
  const length = Math.round((input.length * targetRate) / sourceRate);
  if (length < 1 || length > OUTPUT_SAMPLE_RATE * MAX_OUTPUT_SECONDS) {
    throw new Error('The prepared recording would be too long.');
  }
  if (
    sourceRate < 800 ||
    sourceRate > 384_000 ||
    targetRate < 8_000 ||
    targetRate > 48_000
  ) {
    throw new Error('Unsupported audio resampling rate.');
  }
  if (sourceRate === targetRate) return input;
  const output = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  const cutoff = Math.min(1, targetRate / sourceRate) * 0.94;
  const radius = Math.ceil(24 / cutoff);
  const phases = 1024;
  const taps = radius * 2 + 1;
  const kernels = new Float64Array(phases * taps);
  for (let phase = 0; phase < phases; phase++) {
    let sum = 0;
    for (let tap = 0; tap < taps; tap++) {
      const distance = tap - radius - phase / phases;
      if (Math.abs(distance) > radius) continue;
      const angle = Math.PI * distance * cutoff;
      const sinc = angle === 0 ? 1 : Math.sin(angle) / angle;
      const window =
        0.42 +
        0.5 * Math.cos((Math.PI * distance) / radius) +
        0.08 * Math.cos((2 * Math.PI * distance) / radius);
      const coefficient = cutoff * sinc * window;
      kernels[phase * taps + tap] = coefficient;
      sum += coefficient;
    }
    for (let tap = 0; tap < taps; tap++) kernels[phase * taps + tap] /= sum;
  }
  for (let index = 0; index < length; index++) {
    const center = index * ratio;
    let whole = Math.floor(center);
    let phase = Math.round((center - whole) * phases);
    if (phase === phases) {
      phase = 0;
      whole++;
    }
    const first = whole - radius;
    const kernel = phase * taps;
    let value = 0;
    if (first >= 0 && first + taps <= input.length) {
      for (let tap = 0; tap < taps; tap++)
        value += input[first + tap] * kernels[kernel + tap];
      output[index] = value;
    } else {
      let weight = 0;
      for (
        let tap = Math.max(0, -first);
        tap < Math.min(taps, input.length - first);
        tap++
      ) {
        value += input[first + tap] * kernels[kernel + tap];
        weight += kernels[kernel + tap];
      }
      output[index] = weight ? value / weight : 0;
    }
  }
  return output;
}

export function clipPcm(
  audio: PcmAudio,
  start: number | null,
  end: number | null,
): PcmAudio {
  const samples = audio.channelData[0]?.length ?? 0;
  validateDimensions(audio.sampleRate, audio.channelData.length, samples);
  if (audio.channelData.some((channel) => channel.length !== samples))
    throw new Error('The audio channels have inconsistent lengths.');
  const bounds = clipBounds(samples, audio.sampleRate, start, end);
  return {
    channelData: audio.channelData.map((channel) =>
      channel.subarray(bounds.start, bounds.end),
    ),
    sampleRate: audio.sampleRate,
  };
}

export const DIVISION_FACTOR = 10;

// Zero-crossing frequency division, the way a handheld bat detector keeps
// ultrasonic calls in real time: a square wave whose amplitude follows the
// call's envelope flips twice per output cycle, so every factor/2 upward
// crossings.
export function divideFrequency(
  input: Float32Array,
  sampleRate: number,
  factor = DIVISION_FACTOR,
): Float32Array {
  if (
    !input.length ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isInteger(factor) ||
    factor < 2 ||
    factor % 2
  )
    throw new Error('Invalid frequency division input.');
  const flipEvery = factor / 2;
  const highPass = 1 / (1 + 2 * Math.PI * 12_000 * (1 / sampleRate));
  const filtered = new Float32Array(input.length);
  let previousInput = 0;
  let previousOutput = 0;
  let peak = 0;
  for (let index = 0; index < input.length; index++) {
    const sample = Number.isFinite(input[index]) ? input[index] : 0;
    previousOutput = highPass * (previousOutput + sample - previousInput);
    previousInput = sample;
    filtered[index] = previousOutput;
    peak = Math.max(peak, Math.abs(previousOutput));
  }
  const output = new Float32Array(input.length);
  if (!peak) return output;
  const gate = peak * 0.08;
  const decay = Math.exp(-1 / (sampleRate * 0.002));
  let envelope = 0;
  let crossings = 0;
  let polarity = 1;
  for (let index = 0; index < filtered.length; index++) {
    envelope = Math.max(Math.abs(filtered[index]), envelope * decay);
    if (envelope <= gate) {
      crossings = 0;
      continue;
    }
    if (index > 0 && filtered[index - 1] < 0 && filtered[index] >= 0) {
      crossings++;
      if (crossings % flipEvery === 0) polarity = -polarity;
    }
    output[index] = polarity * envelope;
  }
  return output;
}

export type ProcessingMode = 'natural' | 'bat' | 'realtime';

export function preparePcm(
  audio: PcmAudio,
  mode: ProcessingMode,
  start: number | null,
  end: number | null,
) {
  const source = clipPcm(audio, start, end);
  const sourceDuration = source.channelData[0].length / source.sampleRate;
  const expansion = mode === 'bat' ? 10 : 1;
  if (sourceDuration * expansion > MAX_OUTPUT_SECONDS)
    throw new Error('This recording is too long for 10× bat playback.');
  // Expand at the original rate before filtering: downsampling first would erase the bat calls.
  const channels = source.channelData.map((channel) =>
    resample(
      mode === 'realtime'
        ? divideFrequency(channel, source.sampleRate)
        : channel,
      source.sampleRate / expansion,
      OUTPUT_SAMPLE_RATE,
    ),
  );
  return {
    channelData: channels,
    sampleRate: OUTPUT_SAMPLE_RATE,
    sourceDuration,
    duration: channels[0].length / OUTPUT_SAMPLE_RATE,
  };
}

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  const samples = channels[0]?.length ?? 0;
  if (
    channels.length < 1 ||
    channels.length > 2 ||
    !samples ||
    channels.some((channel) => channel.length !== samples) ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 48_000 ||
    samples / sampleRate > MAX_OUTPUT_SECONDS
  )
    throw new Error('Invalid WAV audio dimensions.');
  const dataBytes = samples * channels.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  for (const [offset, value] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const) {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  }
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let index = 0; index < samples; index++) {
    for (const channel of channels) {
      const sample = Math.max(
        -1,
        Math.min(1, Number.isFinite(channel[index]) ? channel[index] : 0),
      );
      view.setInt16(
        offset,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true,
      );
      offset += 2;
    }
  }
  return buffer;
}

export function waveform(channels: Float32Array[], bars = 80): number[] {
  const samples = channels[0]?.length ?? 0;
  if (!samples || !Number.isInteger(bars) || bars < 1 || bars > 512) return [];
  // Per-bar RMS above the quietest bar: peak levels made every bar look the
  // same because the noise floor of a field recording peaks almost as high as
  // the calls do.
  const levels = Array.from({ length: bars }, (_, bar) => {
    const start = Math.floor((bar * samples) / bars);
    const end = Math.min(
      samples,
      Math.max(start + 1, Math.floor(((bar + 1) * samples) / bars)),
    );
    let squares = 0;
    for (const channel of channels)
      for (let index = start; index < end; index++) {
        const sample = channel[index];
        if (Number.isFinite(sample)) squares += sample * sample;
      }
    return Math.sqrt(squares / ((end - start) * channels.length));
  });
  const max = Math.max(...levels);
  const floor = Math.min(...levels);
  if (!max) return levels;
  if (max === floor) return levels.map(() => 1);
  return levels.map((level) => Math.sqrt((level - floor) / (max - floor)));
}
