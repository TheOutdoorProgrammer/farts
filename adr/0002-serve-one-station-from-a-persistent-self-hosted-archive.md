# 2. Serve one station from a persistent self-hosted archive

Date: 2026-09-21

## Status

Accepted. Supersedes [ADR-0001](0001-use-a-static-browser-player-with-direct-birdweather-access.md).

## Context and Problem Statement

The original static player solved browser playback but still depended on BirdWeather for every visit and shared link.
Joey now wants a reusable service that hosts only the configured station, preserves fetched responses and original files, exposes its readable API capabilities, and shares a family-friendly field journal.
He explicitly chose Go, React, Docker, Helm, public GitHub and GHCR distribution, and approved the FARTS name without a toilet-themed visual design.

## Considered Options

1. Single-station Go server with an embedded persistent metadata store, content-addressed files, and React assets
2. Keep the static browser app with direct API access
3. Run a background crawler and a separate database/object-storage stack

## Decision Outcome

Chosen: **option 1**.

Run one Go process with React assets, a bbolt metadata index and SHA-256 object files on one persistent volume. Fetch requested API resources and media through backend-owned station-scoped operations. Keep successful responses and files without automatic expiry or eviction. Reuse identical bytes across snapshots. Refresh changing views such as latest detections, counts and sensors after a short freshness interval, retain their old snapshots, and serve saved data on upstream failure. Individual recording responses and paginated historical requests remain archived. Serve byte ranges from saved originals and reuse the browser decoder to preserve ultrasonic samples before 10x expansion and WAV export. Never accept caller-selected upstream URLs, station IDs or GraphQL documents. Keep ownership checks before persistence and private location values hidden by default. Publish one reusable multiarchitecture image and Helm chart; each deployment owns its station and volume.

## Consequences

### Good

- Shared recordings survive a later upstream outage once their metadata and media have been requested.
- Visitors use one origin, with no BirdWeather credential or direct API/media request in the browser.
- A single image and persistent volume are enough to self-host; the tested browser audio pipeline is reused.
- An explicit capability inventory exposes station data beyond the family-facing dashboard.

### Bad

- The operator must provide durable storage and backups; retaining files forever consumes disk and a full disk stops new cache writes.
- The on-demand archive contains only resources people have requested, not every station recording.
- Frozen historical responses can preserve an older classification or omit late uploads; dynamic views intentionally make repeat upstream calls.
- The embedded store and volume support one writer; horizontal replicas require a different storage architecture.
- Private station authentication and live subscription transport are not established by public API tests.

### Rejected because

- Direct browser access cannot preserve recordings or fulfill the requested backend-served, single-station archive.
- A full crawler changes the requested on-demand ingestion model and increases upstream/storage use; separate database/object services add deployment requirements this workload does not need.
