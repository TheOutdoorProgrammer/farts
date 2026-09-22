import type {
  Capabilities,
  Dashboard,
  Feed,
  Recording,
  RuntimeConfig,
} from './types';
import { localMedia } from './media';
export { localMedia } from './media';

export type FeedOptions = {
  cursor?: string;
  classification?: 'bird' | 'bat' | 'all';
  query?: string;
  speciesId?: string;
  from?: string;
  to?: string;
  signal?: AbortSignal;
};

function invalid(): never {
  throw new Error(
    'The station returned an incomplete or invalid response. Please try again.',
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length <= 4096 ? value : fallback;
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function unitInterval(value: unknown): number | null {
  const number = nonnegative(value);
  return number !== null && number <= 1 ? number : null;
}

export function safeLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function parseRecording(value: unknown): Recording {
  const data = object(value);
  if (
    typeof data.id !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(data.id) ||
    !Number.isFinite(Date.parse(text(data.timestamp))) ||
    !text(data.commonName) ||
    typeof data.confidence !== 'number' ||
    !Number.isFinite(data.confidence) ||
    data.confidence < 0 ||
    data.confidence > 1
  )
    invalid();
  const recording = { ...data } as unknown as Recording;
  recording.audioUrl = localMedia(data.audioUrl);
  recording.imageCredit = text(data.imageCredit) || null;
  recording.imageLicense = text(data.imageLicense) || null;
  recording.imageUrl =
    recording.imageCredit && recording.imageLicense
      ? localMedia(data.imageUrl)
      : null;
  recording.imageLicenseUrl = safeLink(data.imageLicenseUrl);
  recording.imageSource = safeLink(data.imageSource);
  recording.classification =
    data.classification === 'bird' || data.classification === 'bat'
      ? data.classification
      : 'other';
  recording.scientificName = text(data.scientificName);
  recording.speciesId = text(data.speciesId);
  recording.behavior = text(data.behavior) || null;
  recording.behaviorCode = text(data.behaviorCode) || null;
  recording.certainty = text(data.certainty) || null;
  recording.algorithm = text(data.algorithm) || null;
  recording.probability = unitInterval(data.probability);
  recording.behaviorConfidence = unitInterval(data.behaviorConfidence);
  recording.score = nonnegative(data.score);
  recording.duration = nonnegative(data.duration);
  recording.sampleRate =
    Number.isInteger(data.sampleRate) && (data.sampleRate as number) > 0
      ? (data.sampleRate as number)
      : null;
  recording.soundscapeId = /^[1-9]\d{0,19}$/.test(text(data.soundscapeId))
    ? text(data.soundscapeId)
    : null;
  if (
    !recording.audioUrl ||
    typeof data.startTime !== 'number' ||
    typeof data.endTime !== 'number' ||
    !Number.isFinite(data.startTime) ||
    !Number.isFinite(data.endTime) ||
    data.startTime < 0 ||
    data.endTime <= data.startTime
  ) {
    recording.startTime = null;
    recording.endTime = null;
  }
  return recording;
}

export async function requestJson(
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('\\'))
    throw new Error('Only local station data can be requested.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    30_000,
  );
  try {
    const response = await fetch(path, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? 'This recording is not in the station archive.'
          : `The station is unavailable (HTTP ${response.status}). Please try again.`,
      );
    try {
      return await response.json();
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      invalid();
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchConfig(
  signal?: AbortSignal,
): Promise<RuntimeConfig> {
  const data = object(await requestJson('/api/config', signal));
  if (!text(data.stationId) || !text(data.stationName)) invalid();
  const timezone = text(data.timezone, 'UTC');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    invalid();
  }
  return {
    name: text(data.name, 'FARTS'),
    stationId: text(data.stationId),
    stationName: text(data.stationName),
    stationDescription: text(data.stationDescription ?? data.description),
    timezone,
    version: text(data.version, 'development'),
    faroUrl: text(data.faroUrl),
    publicUrl: text(data.publicUrl),
  };
}

export async function fetchFeed(options: FeedOptions = {}): Promise<Feed> {
  const params = new URLSearchParams();
  for (const key of [
    'cursor',
    'classification',
    'query',
    'speciesId',
    'from',
    'to',
  ] as const) {
    const value = options[key];
    if (value) params.set(key, value);
  }
  // Upstream defaults to recent detections; the journal pages through everything.
  if (!options.from && !options.to) params.set('period', 'all');
  const data = object(await requestJson(`/api/feed?${params}`, options.signal));
  if (!Array.isArray(data.recordings) || data.recordings.length > 100)
    invalid();
  const recordings = data.recordings.map(parseRecording);
  const nextCursor =
    typeof data.nextCursor === 'string' ? data.nextCursor : null;
  if (nextCursor && (nextCursor === options.cursor || recordings.length === 0))
    invalid();
  if (
    new Set(recordings.map((recording) => recording.id)).size !==
    recordings.length
  )
    invalid();
  return {
    ...(data as unknown as Feed),
    recordings,
    nextCursor,
    stale: data.stale === true,
  };
}

export async function fetchRecording(
  id: string,
  signal?: AbortSignal,
): Promise<Recording> {
  if (!/^[1-9]\d{0,19}$/.test(id)) invalid();
  const recording = parseRecording(
    await requestJson(`/api/recordings/${id}`, signal),
  );
  if (recording.id !== id) invalid();
  return recording;
}

export async function fetchDashboard(
  period: string,
  classification: string,
  signal?: AbortSignal,
): Promise<Dashboard> {
  const data = object(
    await requestJson(
      `/api/dashboard?${new URLSearchParams({ period, classification })}`,
      signal,
    ),
  );
  object(data.sections);
  return data as unknown as Dashboard;
}

export async function fetchCapabilities(
  signal?: AbortSignal,
): Promise<Capabilities> {
  const data = object(await requestJson('/api/capabilities', signal));
  if (!Array.isArray(data.operations)) invalid();
  return data as unknown as Capabilities;
}
