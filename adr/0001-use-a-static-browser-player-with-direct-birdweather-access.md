# 1. Use a static browser player with direct BirdWeather access

Date: 2026-09-21

## Status

Accepted.

## Context and Problem Statement

StoutBats recordings are difficult to play and share from BirdWeather's map interface.
Joey requested Cloudflare Workers hosting and challenged an unnecessary server API cache.
Public API and media CORS were verified, while bat FLAC files contain 250 kHz ultrasonic samples that must be preserved before audible conversion.

## Considered Options

1. Static React interface with direct BirdWeather requests and browser-side FLAC processing
2. Worker API proxy with cache and server audio conversion
3. Reuse the existing Home Assistant cards as the sharing interface

## Decision Outcome

Chosen: **option 1**.

Use static Workers assets and a React interface that reads public BirdWeather APIs directly. Decode FLAC at its original rate in a bounded browser worker, then create standard 48 kHz WAV files for native playback and sharing. Bat listening applies 10x time expansion before downsampling. Shared /recordings/:id routes load the exact detection and require no account. No app-owned proxy, backend cache, database, authentication or uploaded audio is needed.

## Consequences

### Good

- Public recordings can be heard and shared without access to Home Assistant or station secrets.
- Static deployment has no application server and avoids unnecessary upstream proxy operations.
- Decoding before resampling preserves ultrasonic bat calls and produces portable audio exports.

### Bad

- The browser downloads a FLAC decoder on first use and spends local CPU and memory preparing clips.
- Availability and retention remain dependent on BirdWeather; shared links stop resolving if upstream removes a recording.
- Static route metadata is generic for link-preview crawlers; recording-specific rich previews would require a server or prerendering.

### Rejected because

- A proxy cache adds operational complexity without evidence of rate-limit or volume pressure and does not solve the source-audio playback issue.
- Existing HA cards require the household HA interface and lack an independent per-recording sharing flow; their basic Audio playback also does not preserve ultrasonic bat calls for audible export.
