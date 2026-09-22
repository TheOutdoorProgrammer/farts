package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TheOutdoorProgrammer/farts/internal/archive"
	"github.com/TheOutdoorProgrammer/farts/internal/config"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	web := filepath.Join(dir, "web")
	if err := os.MkdirAll(filepath.Join(web, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte(`<html><head><title>FARTS</title><meta property="og:title" content="old"></head><body>Wildlife journal</body></html>`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(web, "assets", "test.js"), []byte(`console.log("hello")`), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := archive.Open(filepath.Join(dir, "data"), "42")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return New(config.Config{StationID: "42", StationName: `Owls & <b>Bats</b>`, Timezone: "UTC", PublicURL: "https://recordings.example.com", WebDir: web, MaxMediaBytes: 1024}, store)
}

func TestRoutesHeadersAndNoPublicWrites(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	for _, test := range []struct {
		method, path string
		status       int
	}{{"GET", "/healthz", 200}, {"GET", "/readyz", 200}, {"GET", "/", 200}, {"GET", "/assets/test.js", 200}, {"GET", "/assets/missing.js", 404}, {"GET", "/.env", 404}, {"GET", "/api/unknown", 404}, {"POST", "/api/birdweather/detections", 405}, {"GET", "/media/unknown", 404}, {"GET", "/recordings/bad", 404}, {"GET", "/api/capabilities", 200}} {
		t.Run(test.method+test.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(test.method, test.path, nil)
			h.ServeHTTP(w, r)
			if w.Code != test.status {
				t.Fatalf("got %d: %s", w.Code, w.Body.String())
			}
			if w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("missing security header")
			}
			if strings.Contains(w.Header().Get("Content-Security-Policy"), "birdweather.com") {
				t.Fatal("browser can connect directly upstream")
			}
		})
	}
}

func TestSavedMediaRangesETagAndOriginalDownload(t *testing.T) {
	s := testServer(t)
	id, err := s.store.RegisterMedia("https://media.birdweather.com/soundscapes/42/recording.flac", "audio")
	if err != nil {
		t.Fatal(err)
	}
	media, _ := s.store.Media(id)
	media, err = s.store.SaveMedia(context.Background(), media, strings.NewReader("fLaC0123456789"), "audio/flac", 100)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/media/"+id+"?download=1", nil)
	r.Header.Set("Range", "bytes=4-7")
	h.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "0123" {
		t.Fatalf("range failed %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Content-Disposition"), "attachment") || !strings.Contains(w.Header().Get("Content-Disposition"), "recording.flac") {
		t.Fatal("original filename missing")
	}
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/media/"+id, nil)
	r.Header.Set("If-None-Match", `"`+media.Hash+`"`)
	h.ServeHTTP(w, r)
	if w.Code != 304 || w.Body.Len() != 0 {
		t.Fatal("conditional request failed", w.Code)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("HEAD", "/media/"+id, nil))
	if w.Code != 200 || w.Body.Len() != 0 {
		t.Fatal("HEAD failed", w.Code)
	}
}

func TestUnknownSpeciesCannotBecomeAnOpenProxy(t *testing.T) {
	s := testServer(t)
	var requests int
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if !strings.HasPrefix(r.URL.Path, "/api/v1/stations/42/species") {
			t.Error("escaped configured station", r.URL.Path)
		}
		io.WriteString(w, `{"success":true,"species":[]}`)
	}))
	defer remote.Close()
	s.upstream.BaseURL = remote.URL
	s.upstream.HTTP = remote.Client()
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/birdweather/species/999", nil))
	if w.Code != 404 || requests != 1 {
		t.Fatal("foreign species gate failed", w.Code, requests)
	}
}

func TestPreviewEscapesUpstreamStringsAndOnlyUsesConfiguredOrigin(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "http://attacker.example/recordings/123", nil)
	s.html(w, r, map[string]any{"commonName": `Crow"><script>alert(1)</script>`, "imageUrl": "/media/" + strings.Repeat("a", 64)})
	body := w.Body.String()
	if strings.Contains(body, "<script>") || strings.Contains(body, "attacker.example") {
		t.Fatal("preview injection")
	}
	if strings.Count(body, `property="og:title"`) != 1 || !strings.Contains(body, "https://recordings.example.com/recordings/123") {
		t.Fatal("preview metadata missing or duplicated")
	}
}

func TestPermalinksShareConcurrencyBudget(t *testing.T) {
	s := testServer(t)
	for range cap(s.concurrency) {
		s.concurrency <- struct{}{}
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/recordings/123", nil))
	if w.Code != 503 {
		t.Fatal("permalink bypassed request bound", w.Code)
	}
	var data map[string]any
	if json.Unmarshal(w.Body.Bytes(), &data) != nil || data["error"] == nil {
		t.Fatal("missing overload feedback")
	}
}
