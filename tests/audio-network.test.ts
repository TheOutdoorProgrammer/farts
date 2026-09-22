import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRecording } from '../src/audio/prepare';
import { MAX_DOWNLOAD_BYTES } from '../src/audio/signal';

const url = `/media/${'a'.repeat(64)}`;
afterEach(() => vi.unstubAllGlobals());
describe('archived recording downloads', () => {
  it('fetches only same-origin hashed media without following redirects', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([102, 76, 97, 67])));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('location', { origin: 'https://station.example' });
    expect(await fetchRecording(url)).toEqual(
      new Uint8Array([102, 76, 97, 67]),
    );
    expect(fetch).toHaveBeenCalledWith(
      new URL(url, 'https://station.example'),
      { mode: 'same-origin', credentials: 'same-origin', redirect: 'error' },
    );
    for (const invalid of [
      'https://media.birdweather.com/soundscapes/1/file.flac',
      '//evil.test/media/file',
      '/media/short',
      `${url}?redirect=1`,
    ])
      await expect(fetchRecording(invalid)).rejects.toThrow(
        'not a supported station',
      );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects large downloads based on headers and cancels the body', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { 'Content-Length': String(MAX_DOWNLOAD_BYTES + 1) },
        }),
      ),
    );
    await expect(fetchRecording(url)).rejects.toThrow('24 MB');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('enforces the download limit even without Content-Length', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel,
          }),
        ),
      ),
    );
    await expect(fetchRecording(url)).rejects.toThrow('24 MB');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('distinguishes an absent archive recording from connectivity failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    await expect(fetchRecording(url)).rejects.toThrow('does not have');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    await expect(fetchRecording(url)).rejects.toThrow('Check your connection');
  });
});
