package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	"github.com/TheOutdoorProgrammer/farts/internal/archive"
	"github.com/TheOutdoorProgrammer/farts/internal/config"
	"github.com/TheOutdoorProgrammer/farts/internal/server"
	"github.com/TheOutdoorProgrammer/farts/internal/telemetry"
)

var version = "development"

func main() {
	if err := run(); err != nil {
		slog.Error("application stopped", "reason", err.Error())
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(version)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdown, err := telemetry.Start(ctx, version)
	if err != nil {
		return errors.New("telemetry initialization failed")
	}
	defer func() {
		flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdown(flush); err != nil {
			slog.Error("telemetry shutdown failed")
		}
	}()
	store, err := archive.Open(cfg.DataDir, cfg.StationID)
	if err != nil {
		return errors.New("archive could not be opened; check the volume, permissions, and station configuration")
	}
	defer store.Close()
	app := server.New(cfg, store)
	httpServer := &http.Server{Addr: cfg.ListenAddr, Handler: telemetry.Handler(app.Handler()), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	failed := make(chan error, 1)
	go func() { slog.Info("FARTS started", "version", version); failed <- httpServer.ListenAndServe() }()
	select {
	case <-ctx.Done():
		closeCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return httpServer.Shutdown(closeCtx)
	case err := <-failed:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("HTTP listener stopped")
	}
}
