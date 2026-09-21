import { FLACDecoder, type FLACDecodedAudio } from '@wasm-audio-decoders/flac';
import type { AudioRequest } from './protocol';
import {
  encodeWav,
  inspectFlac,
  MAX_DOWNLOAD_BYTES,
  preparePcm,
  waveform,
} from './signal';

export async function decodeRecording(
  bytes: Uint8Array,
  request: Pick<AudioRequest, 'startTime' | 'endTime' | 'mode'>,
) {
  if (bytes.length > MAX_DOWNLOAD_BYTES)
    throw new Error('This recording exceeds the 24 MB download limit.');
  const info = inspectFlac(bytes);
  const decoder = new FLACDecoder();
  let initialized = false;
  try {
    await decoder.ready;
    initialized = true;
    const channelData = Array.from(
      { length: info.channels },
      () => new Float32Array(info.samples),
    );
    let offset = 0;
    const append = (decoded: FLACDecodedAudio) => {
      if (
        decoded.errors.length ||
        offset + decoded.samplesDecoded > info.samples ||
        (decoded.samplesDecoded > 0 &&
          (decoded.sampleRate !== info.sampleRate ||
            decoded.channelData.length !== info.channels))
      ) {
        throw new Error(
          'The recording is incomplete or damaged. Try another clip.',
        );
      }
      if (decoded.samplesDecoded) {
        for (let channel = 0; channel < info.channels; channel++)
          channelData[channel].set(decoded.channelData[channel], offset);
        offset += decoded.samplesDecoded;
      }
    };
    // Small batches bound transient decoded PCM even if STREAMINFO understates the sample count.
    for (let index = 0; index < bytes.length; index += 512)
      append(await decoder.decode(bytes.subarray(index, index + 512)));
    append(await decoder.flush());
    if (offset !== info.samples) {
      throw new Error(
        'The recording is incomplete or damaged. Try another clip.',
      );
    }
    const pcm = preparePcm(
      { channelData, sampleRate: info.sampleRate },
      request.mode,
      request.startTime,
      request.endTime,
    );
    return {
      wav: encodeWav(pcm.channelData, pcm.sampleRate),
      duration: pcm.duration,
      sourceDuration: pcm.sourceDuration,
      sampleRate: pcm.sampleRate,
      waveform: waveform(pcm.channelData),
    };
  } finally {
    if (initialized) decoder.free();
  }
}

export async function fetchRecording(url: string): Promise<Uint8Array> {
  const source = new URL(url);
  if (
    source.protocol !== 'https:' ||
    source.hostname !== 'media.birdweather.com' ||
    source.port ||
    source.username ||
    source.password ||
    !source.pathname.startsWith('/soundscapes/') ||
    !source.pathname.endsWith('.flac')
  )
    throw new Error(
      'The recording URL is not a supported BirdWeather audio source.',
    );
  let response: Response;
  try {
    response = await fetch(source, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    throw new Error(
      'Could not reach BirdWeather audio. Check your connection and try again.',
    );
  }
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'BirdWeather no longer has this recording.'
        : `BirdWeather could not load this recording (HTTP ${response.status}).`,
    );
  if (Number(response.headers.get('Content-Length')) > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    throw new Error('This recording exceeds the 24 MB download limit.');
  }
  if (!response.body)
    throw new Error('BirdWeather returned an empty recording.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DOWNLOAD_BYTES)
        throw new Error('This recording exceeds the 24 MB download limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
