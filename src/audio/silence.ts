import { encodeWav, OUTPUT_SAMPLE_RATE } from './signal';

// Safari only lets a media element start outside a user gesture once it has
// played inside one, and decoding a recording outlives the tap that asked for it.
export const silentClip = new Blob(
  [encodeWav([new Float32Array(OUTPUT_SAMPLE_RATE / 100)], OUTPUT_SAMPLE_RATE)],
  { type: 'audio/wav' },
);
