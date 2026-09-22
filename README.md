# FARTS

**Flying Animal Recon and Telemetry Service.** A self-hosted field journal for your BirdWeather station.

Listen to birds, make ultrasonic bat calls audible, explore your station's findings, and share a recording with one link. Each installation serves one configured station, with its own name and introduction.

FARTS is an independent project. It uses BirdWeather's cloud APIs and does not connect directly to PUC hardware or perform its own species identification.

## Docker

Choose your public station's numeric ID from its BirdWeather URL. This example uses StoutBats, station 30605.

```sh
docker volume create farts-data
docker run -d --name farts --restart unless-stopped \
  -p 8080:8080 \
  -e FARTS_STATION_ID=30605 \
  -e FARTS_STATION_NAME=StoutBats \
  -e FARTS_PUBLIC_URL=http://localhost:8080 \
  -v farts-data:/data \
  ghcr.io/theoutdoorprogrammer/farts:latest
```

Open <http://localhost:8080>. Images support Linux amd64 and arm64. Use an HTTPS reverse proxy for public sharing. Native file sharing requires browser support and usually HTTPS; copying links and downloading files are also available.

For Compose, copy [.env.example](.env.example) to `.env`, configure your station, and run `docker compose up -d`. Keep the volume across updates. A data directory is bound to its station; switching stations requires a separate directory.

## Kubernetes

```sh
git clone https://github.com/TheOutdoorProgrammer/farts.git
cd farts
helm upgrade --install farts ./charts/farts \
  --namespace farts --create-namespace \
  --set station.id=30605 \
  --set station.name=StoutBats \
  --set publicUrl=https://recordings.example.com \
  --set ingress.enabled=true \
  --set ingress.host=recordings.example.com
```

Configure your ingress class, TLS and storage class in a values file. See [example values](deploy/values.example.yaml) and [chart defaults](charts/farts/values.yaml). The chart runs one non-root instance with a persistent volume and Recreate updates. The archive supports one writer; do not scale it horizontally.

GitHub Actions tests the frontend, backend and Helm chart, checks dependencies and scans the runtime image. The release workflow uses [Quill](https://github.com/NerdsWhoFish/quill) to version and publish the application. GoReleaser builds Linux amd64 and arm64 binaries; Docker packages those artifacts with the already-built React UI. The image build checks the binary's embedded version and commit before accepting it.

Dispatch the release workflow to publish a GitHub release, versioned images at `ghcr.io/theoutdoorprogrammer/farts`, and a matching OCI chart at `oci://ghcr.io/theoutdoorprogrammer/charts/farts`. Stable releases update `latest`; release candidates do not. Pin a version or digest for reproducible deployments. Each GitHub release also contains standalone archives with the binary and UI assets.

## Storage and caching

The browser requests the Go backend. Successful API responses are saved persistently. Original audio, photos and species range files are downloaded on demand and served locally afterward, including byte ranges. Interrupted transfers never become saved files.

- Original files are retained permanently, without automatic eviction.
- Individual recordings and historical pages are archived. They can retain an older identification or omit a later upload.
- Changing views such as latest detections, totals and sensors refresh after a short freshness interval. Earlier response versions remain saved. Caching these forever would freeze current activity.
- Upstream failures fall back to saved responses with a stale indicator. Previously saved media remains available.
- Only requested resources are archived. This is not a background download of the entire station.

The volume contains `archive.db` (bbolt indexes) and content-addressed files in `objects/`. Identical bytes share storage. Monitor free space: a full volume prevents new archive writes. Stop the app before copying the complete directory for a consistent backup; restore with the same station ID. Removing the volume removes the archive.

## Playback and identification

FLAC decoding preserves the original sample rate in a browser worker. Bat mode expands time by 10x before resampling, bringing ultrasonic calls into hearing range. Playback and shareable exports use 48 kHz, 16-bit WAV. Original FLAC downloads preserve uploaded audio. Detection offsets are used when supplied; otherwise the full stored soundscape plays.

Listening copies adjust volume toward a -3 dBFS peak, with a maximum 60 dB boost. Silence, DC offsets and signals below the noise-floor guard are not amplified. The player indicates boosted volume; original downloads and spectrogram measurements stay unchanged.

Selecting a recording opens its player directly beneath that journal entry. Each entry also links to its own recording page. Drag or tap the playhead on either the spectrogram or waveform to seek; the same control supports keyboard arrows, Home and End.

The player shows a spectrogram computed from the original samples, with recorded time and frequency axes. Bat plots preserve ultrasonic frequencies even during slowed playback. Color represents signal amplitude in dBFS, not calibrated sound pressure. Switch to the waveform for a simpler view.

BirdWeather supplies identification, confidence, bat behavior and candidate species. Candidates are possibilities, not confirmed sightings. Species photos retain supplied attribution and licenses. PUC readings and external weather data are separate sources.

## API

The family pages show recordings, statistics, species, activity and station conditions. The Data explorer exposes additional readable capabilities and JSON downloads. [API coverage](docs/api-coverage.md) documents exact operations, parameters and upstream limitations. `/api/capabilities` is the machine-readable catalog.

The public API is read-only and station-scoped. It does not accept arbitrary GraphQL, upstream URLs, other stations, uploads or configuration writes. Species reference data is limited to this station's species. Precise locations are hidden by default. Live subscriptions and private-station GraphQL authentication are not advertised as supported.

Share links use `/recordings/<detection-id>` with server-rendered Open Graph and Twitter cards showing the species, station, and recording date in the station's timezone. Cards and journal entries use credited species photos when available. Station cards choose a photographed species observed by that station. Station pages have their own preview cards, and page selections have shareable URLs. Set `FARTS_PUBLIC_URL` to your public origin so messaging apps can fetch the images without running JavaScript.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FARTS_STATION_ID` | Required | One numeric station ID |
| `FARTS_STATION_NAME` | Upstream name | Display name |
| `FARTS_STATION_DESCRIPTION` | Empty | Station introduction |
| `FARTS_TIMEZONE` | Upstream timezone | Optional IANA timezone override |
| `FARTS_PUBLIC_URL` | Empty | Public origin for share previews |
| `FARTS_LISTEN_ADDR` | `:8080` | HTTP listener |
| `FARTS_DATA_DIR` | `./data` | Persistent archive; `/data` in Docker |
| `FARTS_WEB_DIR` | `./dist` | React assets; `/app/dist` in Docker |
| `FARTS_MAX_MEDIA_BYTES` | `67108864` | Maximum source file size |
| `FARTS_EXPOSE_LOCATION` | `false` | Explicitly publish precise location fields |
| `FARTS_FARO_URL` | Empty | Optional public Faro collector URL |
| `FARTS_STATION_TOKEN` | Empty | Optional server-side REST credential |

Tested public stations need no token. Tokens are credentials: never put one in frontend code or public Helm values. A REST token alone does not establish private-station GraphQL support. Deploying FARTS publishes the data it serves, so configure a station whose information you intend to share.

Upstream requests are bounded, deduplicated while in flight, and limited to four per second and four simultaneous transfers. The service respects Retry-After.

## Observability

JSON logs contain route templates, outcomes and trace correlation. OpenTelemetry spans cover HTTP, upstream calls and archive operations. Set `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` and optional `OTEL_RESOURCE_ATTRIBUTES` to enable traces. Logs go to stdout for your collector. No raw URLs, query strings, credentials or payloads enter telemetry.

Optional Faro browser telemetry uses the shared privacy-filtered client. Its runtime URL must be a public collector endpoint, never a general ingestion credential. Restrict allowed origins at the collector. `/healthz` checks the process; `/readyz` checks archive writes.

## Development

Requires Go 1.26 or later and Node.js 24 or later.

```sh
npm ci
npm run build
FARTS_STATION_ID=30605 go run ./cmd/farts
```

Run `npm run dev` alongside Go for hot reload. Vite proxies API and media requests to `127.0.0.1:8080`.

To build distributable artifacts locally, install GoReleaser 2.18.2 and run `make build`. Go artifacts go into `release/`, separate from Vite's `dist/` so GoReleaser's clean step cannot delete the UI. `make image` packages the snapshot as `farts:local` using Docker. The Dockerfile expects those artifacts and does not compile source. `farts version` prints the embedded version and source commit without opening the archive.

```sh
go test -race ./...
go vet ./...
npm test
npm run build
helm lint charts/farts --strict --set station.id=30605
```

Tests run without BirdWeather network access. Optional real-audio fixtures use `BETTERBIRDS_AUDIO_FIXTURES=/path/to/fixtures` with `bird.flac` and `bat.flac`. No recordings or credentials are bundled.

Architecture decisions are in [adr/](adr/README.md). Code is MIT licensed. Upstream recordings, photos and other third-party content retain their original ownership and licenses.
