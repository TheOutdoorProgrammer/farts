# Better Birds

Listen to and share bird and bat recordings from [StoutBats, BirdWeather station 30605](https://app.birdweather.com/stations/30605).

The local app is ready for review. Publishing is pending, and playback and native file sharing on a physical iPhone have not been verified.

## Development

Requires Node.js and npm. Install the pinned dependencies with `npm ci`.

| Command                | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `npm run dev`          | Vite development server at `http://127.0.0.1:5178`                   |
| `npm test`             | API, audio, player, and telemetry tests                              |
| `npm run build`        | TypeScript checks and production assets in `dist/`                   |
| `npm run preview`      | Serve the existing build through Wrangler at `http://localhost:8788` |
| `npm run check:worker` | Validate the existing build with a Cloudflare deployment dry run     |
| `npm run deploy`       | Build and publish to Cloudflare                                      |

Run `npm run build` before preview or deployment validation. The Wrangler preview applies the production response headers in `public/_headers`.

Three real-recording tests are optional because source recordings are not bundled. To run them, place the station's `30605-20260921-180457.flac` and `30605-20260921-072336.flac` soundscapes in a fixture directory as `bird.flac` and `bat.flac`, then run `BETTERBIRDS_AUDIO_FIXTURES=/path/to/fixtures npm test`. The tests also write WAV exports there. The remaining tests run without network access or fixtures.

## Data and audio

The browser reads BirdWeather directly: GraphQL for paginated station recordings, REST for an exact shared recording and its photo attribution, and the media CDN for audio. There is no API proxy, application data cache, database, or station credential. The current feed and prepared clip exist only as page and playback state. Ordinary browser HTTP caching follows BirdWeather’s response headers.

FLAC decoding runs in a browser worker at the original sample rate. Bat listening expands time by 10× before resampling, bringing ultrasonic calls into hearing range. Playback and exports use 48 kHz, 16-bit WAV. Bird clips use the detection offsets with a little surrounding audio; recordings without offsets use the full soundscape.

Share links use `/recordings/<detection-id>` and open that exact StoutBats detection without an account. Audio can be downloaded as WAV or sent through native file sharing where supported. Bat exports use the audible 10× version. Link previews have generic site metadata because hosting is static.

Species photos are reference images. They appear only when BirdWeather supplies author credit and a license; the selected recording shows that attribution. Confidence values come from BirdWeather, and some bat results identify a family or group rather than a species.

See [ADR 1](adr/0001-use-a-static-browser-player-with-direct-birdweather-access.md) for the architecture decision and rejected alternatives.

## Telemetry

Copy `.env.example` to `.env.local` and set `VITE_FARO_URL` to enable the shared browser telemetry client. Leaving it empty disables telemetry. The app reports sanitized operation failures through `@nerdswhofish/browser-telemetry`.

Vite embeds these values at build time. They must contain no secrets. If the collector host changes, update `connect-src` in `public/_headers` to permit it. Set `VITE_APP_VERSION` to the deployed Git commit so reports identify the build.

## Cloudflare publication

`wrangler.jsonc` deploys `dist/` as Workers static assets with single-page application fallback for shared recording routes. There is no application Worker script. Cloudflare authentication must already be configured for the intended account.

After review and explicit publication approval:

```sh
VITE_APP_VERSION="$(git rev-parse HEAD)" npm run deploy
```

BirdWeather controls upstream availability, retention, and cross-origin access. Shared links stop working if their recordings are removed. Public API and audio CORS were verified during development, but those policies can change. API/media reuse terms still need review before public launch. Physical iPhone playback and the native share sheet remain release checks.
