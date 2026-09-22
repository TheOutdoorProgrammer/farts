import { MAX_OUTPUT_SECONDS, OUTPUT_SAMPLE_RATE } from './signal';

const TARGET_PEAK = 10 ** (-3 / 20);
const MAX_GAIN = 10 ** (60 / 20);
const MIN_AC_RMS = 10 ** (-90 / 20);

export function pcmLevels(channels: Float32Array[]) {
  const samples = channels[0]?.length ?? 0;
  if (
    channels.length < 1 ||
    channels.length > 2 ||
    !samples ||
    samples > OUTPUT_SAMPLE_RATE * MAX_OUTPUT_SECONDS ||
    channels.some((channel) => channel.length !== samples)
  )
    throw new Error('Invalid listening audio dimensions.');
  let peak = 0;
  let squares = 0;
  let variance = 0;
  for (const channel of channels) {
    let sum = 0;
    let channelSquares = 0;
    for (const sample of channel) {
      if (!Number.isFinite(sample))
        throw new Error('The recording contains invalid audio samples.');
      peak = Math.max(peak, Math.abs(sample));
      sum += sample;
      channelSquares += sample * sample;
    }
    const mean = sum / samples;
    squares += channelSquares;
    variance += Math.max(0, channelSquares / samples - mean * mean);
  }
  return {
    peak,
    rms: Math.sqrt(squares / (samples * channels.length)),
    acRms: Math.sqrt(variance / channels.length),
  };
}

export function normalizeListening(channels: Float32Array[]) {
  const { peak, acRms } = pcmLevels(channels);
  // DC and signals below the PCM16 noise floor must not become loud artifacts.
  const ceiling = acRms >= MIN_AC_RMS ? MAX_GAIN : 1;
  const gain = peak ? Math.min(TARGET_PEAK / peak, ceiling) : 1;
  return {
    channelData:
      gain === 1
        ? channels
        : channels.map((channel) => channel.map((sample) => sample * gain)),
    listeningGainDb: 20 * Math.log10(gain),
  };
}
