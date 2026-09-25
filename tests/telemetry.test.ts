import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { captureError, initializeBrowserTelemetry } = vi.hoisted(() => ({
  captureError: vi.fn(),
  initializeBrowserTelemetry: vi.fn(),
}));
vi.mock('@nerdswhofish/browser-telemetry', () => ({
  initializeTelemetry: initializeBrowserTelemetry,
}));
const runtime = {
  faroUrl: 'https://collector.example/collect/test',
  version: 'abcdef01',
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  initializeBrowserTelemetry.mockImplementation(() => ({
    captureError,
    dispose: vi.fn(),
  }));
  captureError.mockImplementation(() => undefined);
  vi.stubGlobal('window', { location: { origin: 'https://station.example' } });
});
afterEach(() => vi.unstubAllGlobals());
describe('runtime browser telemetry', () => {
  it('does not initialize without an explicit runtime collector', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeTelemetry();
    reportError('feed_load', 'network');
    expect(initializeBrowserTelemetry).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });
  it('initializes once from runtime config with fixed routes and version', async () => {
    const { initializeTelemetry } = await import('../src/telemetry');
    initializeTelemetry(runtime);
    initializeTelemetry(runtime);
    expect(initializeBrowserTelemetry).toHaveBeenCalledTimes(1);
    expect(initializeBrowserTelemetry.mock.calls[0][0]).toMatchObject({
      url: runtime.faroUrl,
      app: { name: 'FARTS', version: 'abcdef01', environment: 'development' },
      routes: ['/', '/recordings/:id'],
    });
  });
  it('does not send original errors, station IDs, or recording URLs', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeTelemetry(runtime);
    const original = new Error(
      'SECRET station 30605 https://recordings.example/private',
    );
    reportError('audio_load', 'network', original);
    expect(captureError.mock.calls[0][0]).not.toBe(original);
    expect(captureError.mock.calls[0][0].message).toBe(
      'Browser operation failed',
    );
    expect(JSON.stringify(captureError.mock.calls)).not.toContain('30605');
  });
  it('ignores cancellation and deduplicates reported errors', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeTelemetry(runtime);
    reportError(
      'recording_share',
      'unknown',
      new DOMException('Cancelled', 'AbortError'),
    );
    const error = new Error('private');
    reportError('audio_play', 'playback', error);
    reportError('audio_play', 'playback', error);
    expect(captureError).toHaveBeenCalledTimes(1);
  });
  it('rejects arbitrary operation names and sanitizes failure values', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeTelemetry(runtime);
    reportError('SECRET station' as never, 'network');
    reportError('audio_load', 'SECRET' as never);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0][1]).toBe('audio_load.unknown');
  });
  it.each([
    [1, 'media_aborted'],
    [2, 'media_network'],
    [3, 'media_decode'],
    [4, 'media_unsupported'],
    [null, 'media_unknown'],
    [undefined, 'media_unknown'],
    [0, 'media_unknown'],
    [5, 'media_unknown'],
    [NaN, 'media_unknown'],
    ['4', 'media_unknown'],
    ['SECRET recording URL', 'media_unknown'],
  ])('reports native media code %s as %s', async (code, failure) => {
    const { initializeTelemetry, mediaErrorFailure, reportError } =
      await import('../src/telemetry');
    initializeTelemetry(runtime);
    reportError('audio_play', mediaErrorFailure(code as never));
    expect(captureError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'Browser operation failed' }),
      `audio_play.${failure}`,
    );
    expect(initializeBrowserTelemetry.mock.calls[0][0].operations).toContain(
      `audio_play.${failure}`,
    );
    expect(JSON.stringify(captureError.mock.calls)).not.toContain('SECRET');
  });
  it('keeps application operation independent of SDK failures', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeBrowserTelemetry.mockImplementationOnce(() => {
      throw new Error('SDK failed');
    });
    expect(() => initializeTelemetry(runtime)).not.toThrow();
    initializeTelemetry(runtime);
    captureError.mockImplementationOnce(() => {
      throw new Error('report failed');
    });
    expect(() => reportError('feed_load', 'network')).not.toThrow();
  });
});
