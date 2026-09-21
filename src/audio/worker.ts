import { decodeRecording, fetchRecording } from './prepare';
import type { AudioRequest, AudioResponse } from './protocol';

self.onmessage = async (event: MessageEvent<AudioRequest>) => {
  try {
    const result = await decodeRecording(
      await fetchRecording(event.data.audioUrl),
      event.data,
    );
    const response: AudioResponse = { ok: true, ...result };
    self.postMessage(response, { transfer: [result.wav] });
  } catch (error) {
    const response: AudioResponse = {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Could not prepare this recording.',
    };
    self.postMessage(response);
  }
};
