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
