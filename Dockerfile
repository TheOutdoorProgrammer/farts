# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
ARG VERSION=development
RUN VITE_APP_VERSION="$VERSION" npm run build

FROM --platform=$BUILDPLATFORM golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=development
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /out/farts ./cmd/farts \
    && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
ARG VERSION=development
LABEL org.opencontainers.image.title="FARTS" \
      org.opencontainers.image.description="Flying Animal Recon and Telemetry Service" \
      org.opencontainers.image.source="https://github.com/TheOutdoorProgrammer/farts" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$VERSION"
WORKDIR /app
COPY --from=server /out/farts /app/farts
COPY --from=server --chown=65532:65532 /out/data /data
COPY --from=web /src/dist /app/dist
COPY LICENSE /app/LICENSE
ENV FARTS_LISTEN_ADDR=:8080 FARTS_DATA_DIR=/data FARTS_WEB_DIR=/app/dist
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/farts"]
