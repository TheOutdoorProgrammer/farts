FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
ARG TARGETARCH
ARG VERSION
ARG COMMIT
LABEL org.opencontainers.image.title="FARTS" \
      org.opencontainers.image.description="Flying Animal Recon and Telemetry Service" \
      org.opencontainers.image.source="https://github.com/TheOutdoorProgrammer/farts" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$COMMIT"
WORKDIR /app
COPY release/farts_linux_${TARGETARCH}_*/farts /app/farts
RUN ["/app/farts", "version", "--check"]
COPY dist /app/dist
COPY LICENSE /app/LICENSE
COPY --chown=65532:65532 deploy/data/ /data/
ENV FARTS_LISTEN_ADDR=:8080 FARTS_DATA_DIR=/data FARTS_WEB_DIR=/app/dist
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/farts"]
