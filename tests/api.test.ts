// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFeed, fetchRecording } from '../src/api';

const audioUrl = 'https://media.birdweather.com/soundscapes/30605/bat.flac';
const imageUrl = 'https://media.birdweather.com/species/17282/bat.jpg';
const detection = () => ({
  id: '11278882834',
  stationId: 30605,
  timestamp: '2026-09-21T03:23:36-04:00',
  confidence: 0.8788,
  behavior: 'Search/Clutter',
  lat: 39.87,
  lon: -82.78,
  species: {
    id: '17282',
    classification: 'bat',
    commonName: 'Eastern Red Bat',
    scientificName: 'Lasiurus borealis',
    imageUrl,
    imageCredit:
      '<bdi><a href="//commons.wikimedia.org/wiki/User:Birdwatcher">Jane &amp; John</a></bdi>',
    imageLicense: 'CC BY 4.0',
    imageLicenseUrl: 'http://creativecommons.org/licenses/by/4.0/',
  },
  soundscape: {
    url: audioUrl,
    startTime: null as number | null,
    endTime: null as number | null,
  },
});
const feed = (
  nodes: unknown[] = [detection()],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({
  data: {
    station: {
      id: '30605',
      name: 'StoutBats',
      timezone: 'America/New_York',
      detections: { nodes, pageInfo: { hasNextPage, endCursor } },
    },
  },
});

const fetchMock = vi.fn<typeof fetch>();
const reply = (payload: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe('fetchFeed', () => {
  it('reads one direct public page and preserves real confidence, offsets, and attribution', async () => {
    reply(feed([detection()], true, 'next-page'));
    const result = await fetchFeed({ classification: 'bat' });
    expect(result.station).toEqual({
      id: '30605',
      name: 'StoutBats',
      timezone: 'America/New_York',
    });
    expect(result.nextCursor).toBe('next-page');
    expect(result.recordings[0]).toMatchObject({
      confidence: 0.8788,
      classification: 'bat',
      audioUrl,
      startTime: null,
      endTime: null,
      imageUrl,
      imageCredit: 'Jane & John',
      imageSource: 'https://commons.wikimedia.org/wiki/User:Birdwatcher',
      imageLicense: 'CC BY 4.0',
      imageLicenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    });
    expect(result.recordings[0]).not.toHaveProperty('lat');
    expect(result.recordings[0]).not.toHaveProperty('lon');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.birdweather.com/graphql');
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(JSON.parse(options!.body as string).variables).toEqual({
      after: null,
      classifications: ['bat'],
    });
  });

  it('requests the supplied cursor and maps birds to the upstream avian classification', async () => {
    const bird = detection();
    bird.species.classification = 'avian';
    bird.soundscape.startTime = 4.5;
    bird.soundscape.endTime = 7.5;
    reply(feed([bird]));
    const result = await fetchFeed({
      cursor: 'previous-page',
      classification: 'bird',
    });
    expect(
      JSON.parse(fetchMock.mock.calls[0][1]!.body as string).variables,
    ).toEqual({
      after: 'previous-page',
      classifications: ['avian'],
    });
    expect(result.recordings[0]).toMatchObject({
      classification: 'bird',
      startTime: 4.5,
      endTime: 7.5,
    });
  });

  it.each([undefined, null, {}])(
    'keeps a detection with a missing soundscape (%s)',
    async (soundscape) => {
      reply(feed([{ ...detection(), soundscape }]));
      expect((await fetchFeed()).recordings[0]).toMatchObject({
        audioUrl: null,
        startTime: null,
        endTime: null,
      });
    },
  );

  it.each([
    'javascript:alert(1)',
    'http://media.birdweather.com/soundscapes/bat.flac',
    'https://media.birdweather.com.evil.example/soundscapes/bat.flac',
    'https://media.birdweather.com@evil.example/soundscapes/bat.flac',
    'https://media.birdweather.com:8443/soundscapes/bat.flac',
    'https://media.birdweather.com/species/not-a-recording.jpg',
  ])('rejects unsafe soundscape URL %s', async (url) => {
    reply(
      feed([{ ...detection(), soundscape: { url, startTime: 1, endTime: 2 } }]),
    );
    expect((await fetchFeed()).recordings[0]).toMatchObject({
      audioUrl: null,
      startTime: null,
      endTime: null,
    });
  });

  it.each([
    [4, 2],
    [-1, 3],
    [null, 3],
    [1, Infinity],
  ])('drops invalid clip bounds %s,%s', async (startTime, endTime) => {
    reply(
      feed([
        { ...detection(), soundscape: { url: audioUrl, startTime, endTime } },
      ]),
    );
    expect((await fetchFeed()).recordings[0]).toMatchObject({
      audioUrl,
      startTime: null,
      endTime: null,
    });
  });

  it('extracts inert attribution text and rejects executable credit links', async () => {
    const node = detection();
    node.species.imageCredit =
      '<script>steal()</script><a href="javascript:alert(1)">Photographer</a><img src="https://evil.example/pixel">';
    reply(feed([node]));
    expect((await fetchFeed()).recordings[0]).toMatchObject({
      imageCredit: 'Photographer',
      imageSource: null,
    });
    expect(document.querySelector('script, img')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['imageCredit', 'imageLicense'])(
    'hides photos without %s',
    async (field) => {
      const node = detection();
      reply(feed([{ ...node, species: { ...node.species, [field]: null } }]));
      expect((await fetchFeed()).recordings[0].imageUrl).toBeNull();
    },
  );

  it('rejects unsafe photo media without losing recording audio', async () => {
    const node = detection();
    node.species.imageUrl = 'https://evil.example/bat.jpg';
    reply(feed([node]));
    expect((await fetchFeed()).recordings[0]).toMatchObject({
      imageUrl: null,
      audioUrl,
    });
  });

  it.each([
    { confidence: null },
    { confidence: '0.9' },
    { confidence: 1.2 },
    { confidence: -0.1 },
    { id: '12/../../3' },
    { id: 9007199254740992 },
    { timestamp: 'tomorrow' },
    { timestamp: '2026-09-21T03:23:36' },
    { species: null },
    { soundscape: 'broken' },
  ])('rejects invalid detection fields %j', async (fields) => {
    reply(feed([{ ...detection(), ...fields }]));
    await expect(fetchFeed()).rejects.toThrow('invalid response');
  });

  it('rejects excessive species names', async () => {
    const node = detection();
    node.species.commonName = 'x'.repeat(241);
    reply(feed([node]));
    await expect(fetchFeed()).rejects.toThrow('invalid response');
  });

  it.each([
    { data: { station: null } },
    { ...feed(), errors: [{ message: 'Do not render upstream errors' }] },
    feed([], true, 'next-page'),
    feed([detection()], true, null),
    feed([detection(), detection()]),
  ])('rejects a broken or partial page', async (payload) => {
    reply(payload);
    await expect(fetchFeed()).rejects.toThrow(/BirdWeather/);
  });

  it('rejects a repeated cursor instead of letting load-more loop', async () => {
    reply(feed([detection()], true, 'same-page'));
    await expect(fetchFeed({ cursor: 'same-page' })).rejects.toThrow(
      'invalid response',
    );
  });

  it('returns an empty completed page without inventing recordings', async () => {
    reply(feed([]));
    expect(await fetchFeed()).toMatchObject({
      recordings: [],
      nextCursor: null,
    });
  });

  it.each([429, 500, 503])('reports upstream HTTP %s', async (status) => {
    reply({}, status);
    await expect(fetchFeed()).rejects.toThrow(`HTTP ${status}`);
  });

  it('reports invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Upstream unavailable</html>'),
    );
    await expect(fetchFeed()).rejects.toThrow('invalid response');
  });

  it('propagates cancellation without making a request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchFeed({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels the active direct request', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () =>
            reject(options!.signal!.reason),
          );
        }),
    );
    const pending = fetchFeed({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetchRecording', () => {
  it('loads an exact public detection and its photo attribution', async () => {
    const node = detection();
    reply({
      success: true,
      detection: { ...node, species: { ...node.species, imageCredit: null } },
    });
    reply({
      success: true,
      species: {
        ...node.species,
        imageCredit: 'USGS',
        imageLicense: 'Public domain',
        imageCreditUrl: null,
      },
    });
    expect(await fetchRecording(node.id)).toMatchObject({
      id: node.id,
      imageCredit: 'USGS',
      imageLicense: 'Public domain',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://app.birdweather.com/api/v1/detections/${node.id}`,
      'https://app.birdweather.com/api/v1/species/17282',
    ]);
  });

  it('rejects recordings from a different station before loading metadata', async () => {
    reply({ success: true, detection: { ...detection(), stationId: 1234 } });
    await expect(fetchRecording('11278882834')).rejects.toThrow(
      'not from StoutBats',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched detection IDs', async () => {
    reply({ success: true, detection: { ...detection(), id: '999' } });
    await expect(fetchRecording('11278882834')).rejects.toThrow(
      'invalid response',
    );
  });

  it('rejects mismatched species metadata', async () => {
    reply({ success: true, detection: detection() });
    reply({ success: true, species: { ...detection().species, id: '999' } });
    await expect(fetchRecording('11278882834')).rejects.toThrow(
      'invalid response',
    );
  });

  it.each(['', '0012', '-1', '1.2', '1e5', '../../graphql', '1'.repeat(21)])(
    'rejects invalid ID %s before fetching',
    async (value) => {
      await expect(fetchRecording(value)).rejects.toThrow('invalid response');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('keeps audio available if the optional species lookup fails', async () => {
    reply({ success: true, detection: detection() });
    reply({}, 503);
    expect(await fetchRecording('11278882834')).toMatchObject({
      audioUrl,
      imageUrl: null,
      imageCredit: null,
    });
  });

  it('reports removed recordings', async () => {
    reply({}, 404);
    await expect(fetchRecording('11278882834')).rejects.toThrow(
      'no longer available',
    );
  });
});
