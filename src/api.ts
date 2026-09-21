import type { Feed, Recording } from './types';

const API = 'https://app.birdweather.com';
const STATION_ID = '30605';
const PAGE_SIZE = 36;

const FEED_QUERY = `
  query BetterBirdsFeed($after: String, $classifications: [String!]) {
    station(id: "30605") {
      id name timezone
      detections(first: 36, after: $after, classifications: $classifications) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id timestamp confidence behavior
          species {
            id classification commonName scientificName
            imageUrl imageCredit imageLicense imageLicenseUrl
          }
          soundscape { url startTime endTime }
        }
      }
    }
  }
`;

type ObjectValue = Record<string, unknown>;
type FeedOptions = {
  cursor?: string;
  classification?: 'bird' | 'bat' | 'all';
  signal?: AbortSignal;
};

function invalid(): never {
  throw new Error(
    'BirdWeather returned an incomplete or invalid response. Please try again.',
  );
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as ObjectValue;
}

function text(value: unknown, limit = 240): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result &&
    result.length <= limit &&
    !/[\u0000-\u001f\u007f]/.test(result)
    ? result
    : null;
}

function requiredText(value: unknown, limit = 240): string {
  return text(value, limit) ?? invalid();
}

function id(value: unknown): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1))
    invalid();
  const result = typeof value === 'number' ? String(value) : value;
  if (typeof result !== 'string' || !/^[1-9]\d{0,19}$/.test(result)) invalid();
  return result;
}

function safeLink(value: unknown): string | null {
  const raw = text(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    if (
      url.hostname === 'creativecommons.org' ||
      url.hostname.endsWith('.wikimedia.org')
    ) {
      url.protocol = 'https:';
    }
    return url.href;
  } catch {
    return null;
  }
}

function mediaUrl(
  value: unknown,
  directory: 'soundscapes' | 'species',
): string | null {
  const link = safeLink(value);
  if (!link) return null;
  const url = new URL(link);
  return url.protocol === 'https:' &&
    url.hostname === 'media.birdweather.com' &&
    !url.port &&
    url.pathname.startsWith(`/${directory}/`)
    ? url.href
    : null;
}

function photo(
  species: ObjectValue,
): Pick<
  Recording,
  | 'imageUrl'
  | 'imageCredit'
  | 'imageLicense'
  | 'imageLicenseUrl'
  | 'imageSource'
> {
  const rawCredit =
    text(species.imageCreditHtml, 4096) ?? text(species.imageCredit, 4096);
  let imageCredit: string | null = null;
  let imageSource = safeLink(species.imageCreditUrl);
  if (rawCredit) {
    const template = document.createElement('template');
    template.innerHTML = rawCredit;
    template.content
      .querySelectorAll('script, style, iframe, object, template')
      .forEach((node) => node.remove());
    imageCredit = text(template.content.textContent?.replace(/\s+/g, ' '), 500);
    imageSource ??= safeLink(
      template.content.querySelector('a[href]')?.getAttribute('href'),
    );
  }
  const imageLicense = text(species.imageLicense);
  const imageLicenseUrl = safeLink(species.imageLicenseUrl);
  return {
    imageUrl:
      imageCredit && imageLicense
        ? mediaUrl(species.imageUrl, 'species')
        : null,
    imageCredit,
    imageLicense,
    imageLicenseUrl,
    imageSource,
  };
}

function offset(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function recording(value: unknown): Recording {
  const node = object(value);
  const species = object(node.species);
  const timestamp = requiredText(node.timestamp, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      timestamp,
    ) ||
    !Number.isFinite(Date.parse(timestamp))
  )
    invalid();
  if (
    typeof node.confidence !== 'number' ||
    !Number.isFinite(node.confidence) ||
    node.confidence < 0 ||
    node.confidence > 1
  )
    invalid();
  const soundscape = node.soundscape == null ? null : object(node.soundscape);
  const audioUrl = mediaUrl(soundscape?.url, 'soundscapes');
  let startTime = audioUrl ? offset(soundscape?.startTime) : null;
  let endTime = audioUrl ? offset(soundscape?.endTime) : null;
  if (startTime === null || endTime === null || endTime <= startTime) {
    startTime = null;
    endTime = null;
  }
  return {
    id: id(node.id),
    timestamp,
    commonName: requiredText(species.commonName),
    scientificName: requiredText(species.scientificName),
    speciesId: id(species.id),
    classification:
      species.classification === 'avian'
        ? 'bird'
        : species.classification === 'bat'
          ? 'bat'
          : 'other',
    confidence: node.confidence,
    ...photo(species),
    behavior: text(node.behavior),
    audioUrl,
    startTime,
    endTime,
  };
}

async function request(
  path: string,
  signal?: AbortSignal,
  body?: object,
): Promise<ObjectValue> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    20_000,
  );
  try {
    const response = await fetch(`${API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (response.status === 404)
      throw new Error('This recording is no longer available on BirdWeather.');
    if (!response.ok)
      throw new Error(
        `BirdWeather is unavailable (HTTP ${response.status}). Please try again.`,
      );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      invalid();
    }
    return object(payload);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchFeed(options: FeedOptions = {}): Promise<Feed> {
  const { cursor, classification = 'all', signal } = options;
  if (
    cursor !== undefined &&
    (!text(cursor, 512) || cursor !== cursor.trim())
  ) {
    throw new Error('Invalid recording page. Refresh the feed to start again.');
  }
  if (!['bird', 'bat', 'all'].includes(classification))
    throw new Error('Invalid recording filter.');
  const payload = await request('/graphql', signal, {
    query: FEED_QUERY,
    variables: {
      after: cursor ?? null,
      classifications:
        classification === 'all'
          ? null
          : [classification === 'bird' ? 'avian' : 'bat'],
    },
  });
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error(
      'BirdWeather could not load this recording page. Please try again.',
    );
  }
  const station = object(object(payload.data).station);
  if (id(station.id) !== STATION_ID) invalid();
  const timezone = requiredText(station.timezone, 100);
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    invalid();
  }
  const connection = object(station.detections);
  if (!Array.isArray(connection.nodes) || connection.nodes.length > PAGE_SIZE)
    invalid();
  const recordings = connection.nodes.map(recording);
  if (new Set(recordings.map((item) => item.id)).size !== recordings.length)
    invalid();
  const pageInfo = object(connection.pageInfo);
  if (typeof pageInfo.hasNextPage !== 'boolean') invalid();
  const nextCursor = pageInfo.hasNextPage
    ? requiredText(pageInfo.endCursor, 512)
    : null;
  if (nextCursor && (nextCursor === cursor || recordings.length === 0))
    invalid();
  return {
    station: { id: STATION_ID, name: requiredText(station.name), timezone },
    recordings,
    nextCursor,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchRecording(
  recordingId: string,
  signal?: AbortSignal,
): Promise<Recording> {
  const requestedId = id(recordingId);
  const payload = await request(`/api/v1/detections/${requestedId}`, signal);
  if (payload.success !== true) invalid();
  const node = object(payload.detection);
  if (id(node.stationId) !== STATION_ID)
    throw new Error('This recording is not from StoutBats.');
  if (id(node.id) !== requestedId) invalid();
  const result = recording(node);
  let speciesPayload: ObjectValue;
  try {
    speciesPayload = await request(
      `/api/v1/species/${result.speciesId}`,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    return {
      ...result,
      imageUrl: null,
      imageCredit: null,
      imageLicense: null,
      imageLicenseUrl: null,
      imageSource: null,
    };
  }
  if (speciesPayload.success !== true) invalid();
  const species = object(speciesPayload.species);
  if (id(species.id) !== result.speciesId) invalid();
  return { ...result, ...photo(species) };
}
