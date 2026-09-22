// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchConfig,
  fetchFeed,
  fetchRecording,
  localMedia,
  requestJson,
} from '../src/api';
import { capabilityPath } from '../src/DataExplorer';
import { configureFormat, recordingLink, recordingTime } from '../src/format';
import type { Capability, RuntimeConfig } from '../src/types';

const audioUrl = `/media/${'a'.repeat(64)}`;
const imageUrl = `/media/${'b'.repeat(64)}`;
const detection = () => ({
  id: '11278882834',
  timestamp: '2026-09-21T03:23:36-04:00',
  confidence: 0.8788,
  behavior: 'Search/Clutter',
  speciesId: '17282',
  classification: 'bat' as const,
  commonName: 'Eastern Red Bat',
  scientificName: 'Lasiurus borealis',
  imageUrl,
  imageCredit: 'Jane & John',
  imageLicense: 'CC BY 4.0',
  imageLicenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  imageSource: 'https://commons.wikimedia.org/wiki/User:Birdwatcher',
  audioUrl,
  startTime: null,
  endTime: null,
});
const feed = (
  recordings: unknown[] = [detection()],
  nextCursor: string | null = null,
) => ({
  station: {
    id: '12345',
    name: 'A different station',
    timezone: 'Europe/London',
  },
  recordings,
  nextCursor,
  fetchedAt: '2026-09-21T10:00:00Z',
  stale: false,
});
const fetchMock = vi.fn<typeof fetch>();
const reply = (payload: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(payload), { status }),
  );
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('local station API', () => {
  it('reads a same-origin feed, preserves attribution, and passes filters to the server', async () => {
    reply(feed());
    const result = await fetchFeed({
      classification: 'bat',
      query: 'red',
      from: '2026-09-01',
      speciesId: '17282',
    });
    expect(result.recordings[0]).toMatchObject(detection());
    expect(result.station.name).toBe('A different station');
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/feed?classification=bat&query=red&speciesId=17282&from=2026-09-01',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: 'same-origin',
    });
  });
  it.each([
    'https://media.birdweather.com/soundscapes/1/a.flac',
    '//evil.test/a',
    '/media/short',
    `/media/${'a'.repeat(64)}?redirect=1`,
    `/media/${'a'.repeat(64)}/../private`,
    'javascript:alert(1)',
  ])('refuses external or malformed media: %s', async (value) => {
    expect(localMedia(value)).toBeNull();
    reply(feed([{ ...detection(), audioUrl: value, imageUrl: value }]));
    expect((await fetchFeed()).recordings[0]).toMatchObject({
      audioUrl: null,
      imageUrl: null,
    });
  });
  it('requires photo credit and license before displaying a photo', async () => {
    reply(feed([{ ...detection(), imageCredit: null }]));
    expect((await fetchFeed()).recordings[0].imageUrl).toBeNull();
  });
  it('rejects executable attribution links without losing the recording', async () => {
    reply(feed([{ ...detection(), imageSource: 'javascript:alert(1)' }]));
    expect((await fetchFeed()).recordings[0]).toMatchObject({
      audioUrl,
      imageSource: null,
    });
  });
  it.each([
    { confidence: 1.2 },
    { confidence: null },
    { timestamp: 'tomorrow' },
    { id: '../123' },
    { commonName: '' },
  ])('rejects invalid detection fields %j', async (fields) => {
    reply(feed([{ ...detection(), ...fields }]));
    await expect(fetchFeed()).rejects.toThrow('invalid response');
  });
  it('prevents repeated pagination cursors and duplicate recordings', async () => {
    reply(feed([detection()], 'same'));
    await expect(fetchFeed({ cursor: 'same' })).rejects.toThrow(
      'invalid response',
    );
    reply(feed([detection(), detection()]));
    await expect(fetchFeed()).rejects.toThrow('invalid response');
  });
  it('loads permanent recording URLs from the local archive and validates the ID', async () => {
    reply(detection());
    expect((await fetchRecording('11278882834')).id).toBe('11278882834');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/recordings/11278882834');
    reply({ ...detection(), id: '99' });
    await expect(fetchRecording('11278882834')).rejects.toThrow(
      'invalid response',
    );
    await expect(fetchRecording('../config')).rejects.toThrow(
      'invalid response',
    );
  });
  it('loads station identity, timezone, telemetry, and public URL at runtime', async () => {
    const config = {
      name: 'FARTS',
      stationId: '54321',
      stationName: 'Forest House',
      timezone: 'Pacific/Auckland',
      publicUrl: 'https://wild.example',
      faroUrl: '',
      version: 'test',
      stationDescription: 'Our visitors',
    };
    reply(config);
    expect(await fetchConfig()).toEqual(config);
    configureFormat(config);
    expect(recordingTime('2026-09-21T00:00:00Z')).toBe('12:00 PM');
    expect(recordingLink(detection())).toBe(
      'https://wild.example/recordings/11278882834',
    );
  });
  it('rejects invalid runtime timezones', async () => {
    reply({ stationId: '1', stationName: 'Station', timezone: 'Not/AZone' });
    await expect(fetchConfig()).rejects.toThrow('invalid response');
  });
  it('does not request arbitrary external URLs or cancelled operations', async () => {
    await expect(requestJson('https://evil.test/api/config')).rejects.toThrow(
      'Only local',
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchFeed({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reports HTTP failures and malformed JSON', async () => {
    reply({}, 503);
    await expect(fetchFeed()).rejects.toThrow('HTTP 503');
    fetchMock.mockResolvedValueOnce(new Response('<html>broken</html>'));
    await expect(fetchFeed()).rejects.toThrow('invalid response');
  });
});

describe('capability explorer', () => {
  const operation: Capability = {
    id: 'recording',
    label: 'Recording',
    description: 'A recording',
    path: '/api/recordings/:id',
    method: 'GET',
    parameters: [
      { name: 'id', type: 'string', required: true },
      { name: 'format', type: 'string', default: 'full' },
    ],
  };
  it('encodes ID placeholders and query values', () => {
    expect(
      capabilityPath(operation, { id: '123', format: 'raw details' }),
    ).toBe('/api/recordings/123?format=raw+details');
  });
  it('rejects missing required parameters and external paths', () => {
    expect(() => capabilityPath(operation, {})).toThrow('Enter id');
    expect(() =>
      capabilityPath(
        { ...operation, path: 'https://evil.test/:id' },
        { id: '123' },
      ),
    ).toThrow('invalid local path');
  });
});
