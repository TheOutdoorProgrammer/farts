# 3. Release prebuilt artifacts through Quill

Date: 2026-09-21

## Status

Accepted.

## Context and Problem Statement

The application needs public Linux amd64 and arm64 images and an installable Helm chart.
Compiling inside Docker repeated the Go and frontend build for each image check and publication.
The existing Quill action already owns release versioning and runs GoReleaser before Docker.

## Considered Options

1. Use Quill with GoReleaser artifacts and a packaging-only Dockerfile
2. Keep an independent image workflow that compiles source inside Docker

## Decision Outcome

Chosen: **option 1**.

Use a pinned NerdsWhoFish/quill release action with its goreleaser,docker publishers. Build React assets outside Docker and put GoReleaser output in release/ so its clean step preserves Vite's dist/. Docker copies the matching target binary and UI, then checks the binary's embedded version and full commit against the intended image. Keep Docker dry runs and shared build caches disabled in the release transaction to prevent snapshot artifacts reaching stable images. CI scans both Linux architectures before publication. Package the Helm chart using Quill's version, and default its image to the same application version. Deployment pins the published image digest.

## Consequences

### Good

- The Docker build packages existing artifacts without repeating compilation.
- Shared release tooling owns version calculation, tags, and publisher order.
- Standalone archives and container images contain the same compiled application and UI.
- Version checks reject stale snapshot binaries before image publication.

### Bad

- Building an image from a checkout first requires GoReleaser and the frontend toolchain.
- Quill intentionally builds a snapshot before the final release, so those two versioned binary builds remain.
- Helm publication follows Quill as a separate job; a chart upload failure needs recovery even if application artifacts already published.

### Rejected because

- The independent multi-stage Docker workflow duplicates the expensive build and release orchestration already provided by Quill.
