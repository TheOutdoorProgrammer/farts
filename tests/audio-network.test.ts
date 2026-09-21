import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRecording } from '../src/audio/prepare';
import { MAX_DOWNLOAD_BYTES } from '../src/audio/signal';

const url = 'https://media.birdweather.com/soundscapes/30605/recording.flac';
afterEach(() => vi.unstubAllGlobals());

describe('direct recording downloads', () => {
  it('fetches only public BirdWeather soundscapes without credentials or a proxy', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([102, 76, 97, 67])));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchRecording(url)).toEqual(
      new Uint8Array([102, 76, 97, 67]),
    );
    expect(fetch).toHaveBeenCalledWith(new URL(url), {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
    });
    for (const invalid of [
      url.replace('https:', 'http:'),
      url.replace('media.birdweather.com', 'evil.test'),
      url.replace('/soundscapes/', '/private/'),
      url.replace('.flac', '.html'),
    ]) {
      await expect(fetchRecording(invalid)).rejects.toThrow(
        'not a supported BirdWeather',
      );
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects large downloads based on headers and cancels the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { 'Content-Length': String(MAX_DOWNLOAD_BYTES + 1) },
        }),
      ),
    );
    await expect(fetchRecording(url)).rejects.toThrow('24 MB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('enforces download limits even when Content-Length is absent', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(fetchRecording(url)).rejects.toThrow('24 MB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('distinguishes an unavailable recording from connectivity failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    await expect(fetchRecording(url)).rejects.toThrow('no longer has');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    await expect(fetchRecording(url)).rejects.toThrow('Check your connection');
  });
});
