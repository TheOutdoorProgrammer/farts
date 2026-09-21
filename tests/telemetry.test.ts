import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureError, initializeBrowserTelemetry } = vi.hoisted(() => ({
  captureError: vi.fn(),
  initializeBrowserTelemetry: vi.fn(),
}));

vi.mock('@nerdswhofish/browser-telemetry', () => ({
  initializeTelemetry: initializeBrowserTelemetry,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  initializeBrowserTelemetry.mockImplementation(() => ({
    captureError,
    dispose: vi.fn(),
  }));
  captureError.mockImplementation(() => undefined);
  vi.stubGlobal('window', {
    location: { origin: 'https://betterbirds.example' },
  });
  vi.stubEnv('VITE_FARO_URL', 'https://collector.example/collect/test');
  vi.stubEnv('VITE_APP_VERSION', 'abcdef0123456789abcdef0123456789abcdef01');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('browser telemetry', () => {
  it('does not initialize a collector unless explicitly configured', async () => {
    vi.stubEnv('VITE_FARO_URL', '');
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeTelemetry();
    reportError('feed_load', 'network');
    expect(initializeBrowserTelemetry).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it('initializes once with fixed routes and a build revision', async () => {
    const { initializeTelemetry } = await import('../src/telemetry');
    initializeTelemetry();
    initializeTelemetry();
    expect(initializeBrowserTelemetry).toHaveBeenCalledTimes(1);
    const config = initializeBrowserTelemetry.mock.calls[0][0];
    expect(config.app).toEqual({
      name: 'Better Birds',
      version: 'abcdef0123456789abcdef0123456789abcdef01',
      environment: 'development',
    });
    expect(config.routes).toEqual(['/', '/recordings/:id']);
    expect(config.operations).toContain('audio_load.decode');
    expect(config.operations).toContain('recording_share.permission');
    expect(config.local).toBeUndefined();
  });

  it('never passes original errors, identifiers, or URLs to the collector', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeTelemetry();
    const original = new Error(
      'SECRET station 30605 species 444 detection 123 https://recordings.example/private',
    );
    reportError('audio_load', 'network', original);
    expect(captureError).toHaveBeenCalledTimes(1);
    const [error, operation] = captureError.mock.calls[0];
    expect(error).not.toBe(original);
    expect(error.message).toBe('Browser operation failed');
    expect(error.stack).not.toContain('SECRET');
    expect(operation).toBe('audio_load.network');
    expect(JSON.stringify(captureError.mock.calls)).not.toContain('30605');
  });

  it('ignores cancellation and deduplicates the same reported error', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeTelemetry();
    reportError(
      'recording_share',
      'unknown',
      new DOMException('User cancelled', 'AbortError'),
    );
    const error = new Error('private failure');
    reportError('audio_play', 'playback', error);
    reportError('audio_play', 'playback', error);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it('rejects arbitrary operation names and sanitizes invalid failure values', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeTelemetry();
    reportError('SECRET station 30605' as never, 'network');
    reportError('audio_load', 'SECRET URL' as never);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0][1]).toBe('audio_load.unknown');
  });

  it('keeps startup and handled application failures independent of SDK failures', async () => {
    const { initializeTelemetry, reportError } =
      await import('../src/telemetry');
    initializeBrowserTelemetry.mockImplementationOnce(() => {
      throw new Error('SDK failed');
    });
    expect(initializeTelemetry).not.toThrow();
    initializeTelemetry();
    captureError.mockImplementationOnce(() => {
      throw new Error('Reporting failed');
    });
    expect(() => reportError('feed_load', 'network')).not.toThrow();
  });
});
