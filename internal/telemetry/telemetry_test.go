package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestRequestTelemetryPropagatesTraceWithoutPrivateInput(t *testing.T) {
	oldProvider, oldPropagator, oldLogger := otel.GetTracerProvider(), otel.GetTextMapPropagator(), slog.Default()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	var logs bytes.Buffer
	slog.SetDefault(slog.New(traceHandler{slog.NewJSONHandler(&logs, nil)}))
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(oldProvider)
		otel.SetTextMapPropagator(oldPropagator)
		slog.SetDefault(oldLogger)
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/recordings/{id}", func(w http.ResponseWriter, r *http.Request) {
		_, span := otel.Tracer("test").Start(r.Context(), "archive.read")
		defer span.End()
		w.WriteHeader(http.StatusBadGateway)
	})
	request := httptest.NewRequest(http.MethodGet, "https://private-host.invalid/api/recordings/private-recording?token=private-token", nil)
	request.Header.Set("Authorization", "Bearer private-credential")
	request.Header.Set("traceparent", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")
	Handler(mux).ServeHTTP(httptest.NewRecorder(), request)
	spans := recorder.Ended()
	if len(spans) != 2 {
		t.Fatalf("expected HTTP and archive spans, got %d", len(spans))
	}
	for _, span := range spans {
		if got := span.SpanContext().TraceID().String(); got != "0123456789abcdef0123456789abcdef" {
			t.Fatalf("trace propagation lost: %s", got)
		}
		encoded, _ := json.Marshal(span.Attributes())
		if strings.Contains(string(encoded), "private-") {
			t.Fatalf("private request input leaked into span attributes: %s", encoded)
		}
	}
	if spans[1].Name() != "GET /api/recordings/{id}" {
		t.Fatalf("request span does not use route template: %q", spans[1].Name())
	}
	var event map[string]any
	if err := json.Unmarshal(logs.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["trace_id"] != "0123456789abcdef0123456789abcdef" || event["http_route"] != "GET /api/recordings/{id}" || event["level"] != "ERROR" {
		t.Fatalf("request log is not correlated: %v", event)
	}
	if strings.Contains(logs.String(), "private-") {
		t.Fatal("private request input leaked into logs")
	}
}
