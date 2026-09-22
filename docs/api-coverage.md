# BirdWeather API coverage

FARTS exposes named, read-only requests for one configured station. The public route catalog is `GET /api/capabilities`; it is generated from the same parameter allowlists used by the adapter. Clients cannot submit upstream URLs, station IDs, GraphQL documents, mutations, or arbitrary request bodies.

The source references are BirdWeather's [REST documentation](https://app.birdweather.com/api/v1) and [GraphQL documentation](https://app.birdweather.com/api/). The live GraphQL schema was also inspected because it differs from the static documentation. Verification used bounded anonymous reads of station 30605 on September 21, 2026, including both bird and Bat Edition detections. This is coverage of useful station reads, not every global BirdWeather operation.

## Application responses

- `GET /api/feed`: normalized recordings and station metadata, an opaque `nextCursor`, `fetchedAt`, and `stale`. `classification` accepts `all`, `bird`, or `bat`; `cursor` aliases GraphQL `after`. Other filters use the detection preset below.
- `GET /api/recordings/:id`: one station-owned recording with REST soundscape and species enrichment. IDs are strings. `raw` retains upstream detection metadata after the HTTP layer applies privacy and media policies.
- `GET /api/dashboard`: independent `counts`, `species`, `daily`, `timeOfDay`, `weather`, and `sensors` sections. Each has `data`, `fetchedAt`, `stale`, and an optional safe `error`. One unavailable capability does not remove the other sections. It accepts period parameters, `classification=all|bird|bat`, `speciesId`, and `limit` (default 20).

Recordings retain the actual confidence, probability, score, algorithm, behavior and behavior confidence, candidate shortlist, sample rate, duration, and soundscape ID where available. A shortlist candidate is an alternative identification, not a confirmed species. Missing soundscapes and offsets remain null. The detail route preserves fractional REST durations; GraphQL's soundscape duration is an integer.

Photos require credit and license metadata. HTML credit is reduced to text and a safe source link. The feed and species ranking fall back to REST species metadata when GraphQL omits attribution. Optional enrichment failures do not hide the recording. The HTTP layer rewrites eligible media URLs to local media routes; the adapter never accepts a user-supplied media URL.

## REST resources

All application routes below are GET requests under `/api/birdweather/`. The upstream station segment is inserted by the backend.

| Resource | Upstream read | Accepted parameters |
| --- | --- | --- |
| `stats` | `/api/v1/stations/{station}/stats` | `period`, `since`, `mode`, `classification` |
| `species` | `/api/v1/stations/{station}/species` | `period`, `from`, `to`, `since`, `limit`, `page`, `sort`, `order`, `speciesId`, `query`, `mode`, `locale`, `classification` |
| `species/:id` | `/api/v1/species/{id}` | None; species must already be eligible for this station |
| `detections` | `/api/v1/stations/{station}/detections` | `limit`, numeric `cursor`, `from`, `to`, `speciesId`, `query`, `mode`, `locale`, `classification`, `behavior`, `shortlist` |
| `detections/:id` | `/api/v1/stations/{station}/detections/{id}` | None |
| `soundscapes` | `/api/v1/stations/{station}/soundscapes` | `limit`, numeric `cursor`, `from`, `to`, `speciesId`, `detections` |
| `soundscapes/:id` | `/api/v1/stations/{station}/soundscapes/{id}` | `detections` |
| `weather` | `/api/v1/stations/{station}/weather` | None; working endpoint observed in the official application, absent from its REST reference |
| `global-detection/:id` | `/api/v1/detections/{id}` | None; returned station membership is mandatory |
| `species-lookup` | GraphQL `allSpecies(ids:...)` | Comma-separated `ids`, at most 50 eligible species |

REST relative periods are `day`, `week`, `month`, and `all`. Lists are capped at 100 items. Species pagination is page-based; detection and soundscape pagination uses a numeric cursor. REST `from`, `to`, and `since` accept ISO timestamps or dates. Classification uses upstream names such as `avian` and `bat`; the application feed maps `bird` to `avian`. Accepted sort, mode, classification, and behavior values appear in the catalog or parameter validation code.

The documented name-based `POST /api/v1/species/lookup` is a read operation, but FARTS deliberately provides an ID-only GraphQL equivalent. This preserves batch lookup without opening a global taxonomy search or accepting arbitrary bodies. Older global detection IDs may require the station-specific detail endpoint.

## GraphQL presets

All are GET requests to `/api/graphql/{operation}`. The backend issues fixed GraphQL POST documents with typed variables. The catalog describes each preset and accepted parameters.

| Operation | Upstream field | Parameters beyond common period/pagination |
| --- | --- | --- |
| `station` | `station` | None |
| `counts` | `counts(stationIds:...)` | Period, `speciesId`, `classifications` |
| `species` | `topSpecies(stationIds:...)` | Period, `speciesId`, `classifications`, `recordingModes`, `limit`, `offset` |
| `detections` | `detections(stationIds:...)` | Period, pagination, `speciesId`, `speciesIds`, `classifications`, `recordingModes`, `behaviors`, thresholds, `vote`, `sortBy`, `validSoundscape`, `overrideStationFilters` |
| `detection-counts` | `station.detectionCounts` | Period, `speciesId`, thresholds |
| `daily-counts` | `dailyDetectionCounts(stationIds:...)` | Period, `speciesIds` |
| `time-of-day` | `timeOfDayDetectionCounts(stationIds:...)` | Period, `speciesId`, thresholds |
| `weather` | `station.weather`, `station.airPollution` | None |
| `sensors` | `station.sensors` | Optional `sensorType`, `fieldName` |
| `probabilities` | `station.probabilities` | None; monthly and weekly geographic reference probabilities |
| `species-details` | `species` | Required `speciesId` |
| `species-range` | `species.range`, `rangeUrl`, `predictionArea` | Required `speciesId` |
| `species-counts` | `species.detectionCounts(stationIds:...)` | Required `speciesId`, period, `group` |
| `species-probabilities` | `species.probabilities` | Required `speciesId`, `model`; bounds fixed to configured station coordinates |
| `species-lookup` | `allSpecies` | Required comma-separated `ids`, at most 50 |
| `species-search` | Station REST species list, adapted to `data.searchSpecies.nodes` | `query`, `locale`, `classification`, `limit`, `page`, REST `period` |
| `environment-history` | `station.sensors.environmentHistory` | Period, pagination |
| `system-history` | `station.sensors.systemHistory` | Period, pagination |
| `accel-history` | `station.sensors.accelHistory` | Period, pagination |
| `mag-history` | `station.sensors.magHistory` | Period, pagination |
| `light-history` | `station.sensors.lightHistory` | Period, pagination |
| `location-history` | `station.sensors.locationHistory` | Period, pagination; public coordinate redaction still applies |
| `detections-history` | `station.sensors.detectionsHistory` | Period, pagination; upstream currently fails, independently of other histories |

Common period parameters are `period=day|week|month|year|all`, paired `count`/`unit`, or `from`/`to` dates with optional IANA `timezone`. These forms cannot be mixed. Explicit dates use the station timezone by default. `all` becomes a date interval from the station's earliest detection through its current local date. Dashboard bird/bat filters apply upstream to counts/rankings and to classified species rows in daily/time-of-day charts.

Relay pagination accepts `first`/`after` or `last`/`before`, defaults to 36 items, and is capped at 100. Conflicting directions are rejected. Threshold suffixes are `Gt`, `Lt`, `Gte`, and `Lte` for confidence, probability, and score. `timeOfDayGte`/`timeOfDayLte` are also exposed. `sortBy`, sensor selector semantics, and time-of-day filter units need further upstream verification; accepting a bounded value does not guarantee the server implements every value. Probability models are `BIRDNET`, `FOGLEMAN`, `INATURALIST`, and `BIRDWEATHER`; availability varies by species/model.

Species references include names, classification, translations, image attribution, external reference links, Wikipedia metadata, and geographic range files where available. Reference ranges/probabilities describe species geography, not measurements made by this station. The HTTP layer separately verifies station eligibility for species IDs.

## Sensor and audio semantics

Latest sensors and their histories expose environment, system/power/storage/Wi-Fi, accelerometer, magnetometer, light, and location readings. SD capacities are decimal strings. Firmware is absent from the live `SystemReading` schema despite appearing in older documentation; `usbVoltage` is present.

OpenWeather temperature is Kelvin, wind speed is metres per second, pressure is hPa, precipitation is millimetres, and its pollution AQI is 1 through 5. PUC environmental readings are a different source; do not apply OpenWeather's AQI labels to PUC AQI values. Raw motion/light sensor units are not documented by the inspected API schema. Parse timestamps as instants and render in the station timezone.

A soundscape URL is the complete uploaded file associated with one or more detections. It does not establish access to continuous microphone capture or recordings the hardware never uploaded. Bat Edition verification returned a 250 kHz FLAC with a 6.0002-second duration and null detection offsets. Ordinary bird files were also observed at 48 kHz. Original audio, derived WAV, and 10x time-expanded playback are distinct representations; preserve the actual sample rate and never invent bat clip offsets.

The inspected REST metadata and live GraphQL `Soundscape`/`Detection` fields expose no spectrogram, spectrum, or waveform asset. A spectrogram must be derived from decoded audio samples. Computing it after resampling to a typical playback sample rate loses ultrasonic content; frequency labels must distinguish original audio from slowed playback.

## Validation and retention

Responses are validated before persistence, including successful HTTP responses containing GraphQL errors or `success:false`, station ownership, identifiers, list shapes, and pagination. Unknown or duplicate parameters, nonfinite numbers, oversized pages/strings/batches, and malformed intervals are rejected before upstream access. A cursor never grants station access.

The configured archive policy retains requested fixed-ID records, reference details, subsequent cursor pages, and closed date intervals as snapshots. These snapshots can differ from later upstream corrections or deletions. Latest data is fresh for 60 seconds; station metadata and station probability reference data for 300 seconds. Successful snapshots carry fetch time and stale status; failures do not become permanent successes. This is an on-demand archive, not a background crawl or a complete backup of the station.

## Limits and exclusions

- Bounded requests through FARTS passed 32 of 33 advertised operations, including all REST mappings and six sensor histories. `detectionsHistory` returned upstream HTTP 500. Two redundant nested species fields violated the upstream non-null schema; the species histogram and probability presets omit those fields and retain the enclosing species identity. Both repaired presets returned HTTP 200; the tested probability model returned an empty locations array at the configured bounds.
- Connection `totalCount` and `speciesCount` did not reliably reflect bat filters during verification. The normalized feed omits those totals. Time-of-day bins returned 33 detections while daily/counts returned 172 for a week; an explicit date interval did not fix that discrepancy. Dashboard aggregates retain their own upstream definitions; time-of-day output is not represented as matching the selected period's total.
- Global stations, eBird/BirdNET sightings, cross-station species relationships, and action URLs are excluded. Public responses redact station location data according to application policy.
- No station writes, audio uploads, configuration changes, favorite/flag/vote actions, or arbitrary GraphQL are exposed. Documented REST writes are POST station `detections`, `soundscapes`, and `config`.
- The schema advertises a `newDetection` subscription, but its transport/authentication/delivery behavior was not verified. FARTS does not advertise live subscriptions.
- Numeric station IDs worked anonymously for the tested public station. Owner station tokens are authentication credentials, not public read-only keys. Private-station authentication was not verified and is not claimed as supported.
- No numeric rate limit or retention guarantee was found in the inspected API references. Upstream availability, API behavior, media retention, and terms can change. API access alone is not a blanket content redistribution license; retain attribution and review BirdWeather's current terms for the intended use.
