import { initializeTelemetry as initializeBrowserTelemetry } from '@nerdswhofish/browser-telemetry';

const operations = [
  'feed_load',
  'audio_load',
  'audio_play',
  'audio_export',
  'recording_share',
  'app_render',
] as const;
const failures = [
  'network',
  'invalid_data',
  'unavailable',
  'decode',
  'playback',
  'permission',
  'unsupported',
  'unknown',
] as const;

export type TelemetryOperation = (typeof operations)[number];
export type TelemetryFailure = (typeof failures)[number];

let telemetry: ReturnType<typeof initializeBrowserTelemetry> | undefined;
const reportedErrors = new WeakSet<Error>();

export function initializeTelemetry(): void {
  if (
    telemetry ||
    typeof window === 'undefined' ||
    !import.meta.env.VITE_FARO_URL
  )
    return;

  try {
    const scriptPath = new URL(import.meta.url).pathname;
    telemetry = initializeBrowserTelemetry({
      url: import.meta.env.VITE_FARO_URL,
      app: {
        name: 'Better Birds',
        version: import.meta.env.VITE_APP_VERSION || 'development',
        environment: import.meta.env.PROD ? 'production' : 'development',
      },
      // The shared filter treats parameterized paths as /{other}, never as recording IDs.
      routes: ['/', '/recordings/:id'],
      assets: scriptPath.startsWith('/assets/') ? [scriptPath] : [],
      operations: operations.flatMap((operation) =>
        failures.map((failure) => `${operation}.${failure}`),
      ),
    });
  } catch {
    // Instrumentation must not make recordings unavailable if the SDK cannot initialize.
  }
}

export function reportError(
  operation: TelemetryOperation,
  failure: TelemetryFailure,
  error?: unknown,
): void {
  if (!telemetry || !operations.includes(operation)) return;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || reportedErrors.has(error))
  )
    return;

  const safeFailure = failures.includes(failure) ? failure : 'unknown';
  try {
    telemetry.captureError(
      new Error('Browser operation failed'),
      `${operation}.${safeFailure}`,
    );
    if (error instanceof Error) reportedErrors.add(error);
  } catch {
    // Reporting a handled failure must not turn it into an unhandled application failure.
  }
}
