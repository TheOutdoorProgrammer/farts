package upstream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TheOutdoorProgrammer/farts/internal/archive"
	"github.com/TheOutdoorProgrammer/farts/internal/birdweather"
)

func testClient(t *testing.T, handler http.HandlerFunc) (*Client, *archive.Store) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	store, err := archive.Open(t.TempDir(), "42")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	client := New(store, "42", "", 1024)
	client.BaseURL = server.URL
	client.HTTP = server.Client()
	return client, store
}

func TestConcurrentMissesFetchOnceAndPersist(t *testing.T) {
	var calls atomic.Int32
	client, store := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		time.Sleep(30 * time.Millisecond)
		io.WriteString(w, `{"success":true,"detection":{"id":100,"stationId":42,"speciesId":7,"timestamp":"2026-09-21T12:00:00Z","confidence":0.9,"species":{"id":7,"commonName":"Crow","scientificName":"Corvus","classification":"avian"}}}`)
	})
	req := birdweather.Request{Operation: "rest:detections", Path: "/api/v1/stations/42/detections/100", Method: "GET", Immutable: true}
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := client.Do(context.Background(), req); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	client = New(store, "42", "", 1024)
	client.BaseURL = "http://127.0.0.1:1"
	if _, err := client.Do(context.Background(), req); err != nil {
		t.Fatal("cached response still needed upstream", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("upstream called %d times", calls.Load())
	}
	if !store.HasSpecies("7") {
		t.Fatal("station species membership was not retained")
	}
}

func TestUpstreamFailureServesStaleAndRecovers(t *testing.T) {
	var broken atomic.Bool
	client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if broken.Load() {
			w.WriteHeader(500)
			return
		}
		io.WriteString(w, `{"success":true,"detections":3,"species":2}`)
	})
	req := birdweather.Request{Operation: "rest:stats", Path: "/api/v1/stations/42/stats", Method: "GET", FreshFor: time.Nanosecond}
	first, err := client.Do(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	broken.Store(true)
	stale, err := client.Do(context.Background(), req)
	if err != nil || !stale.Stale || !stale.FetchedAt.Equal(first.FetchedAt) {
		t.Fatalf("bad fallback: %+v %v", stale, err)
	}
	broken.Store(false)
	fresh, err := client.Do(context.Background(), req)
	if err != nil || fresh.Stale {
		t.Fatalf("no recovery: %+v %v", fresh, err)
	}
}

func TestMalformedAndForeignResponsesNeverEnterArchive(t *testing.T) {
	for _, body := range []string{`{"success":false}`, `{"errors":[{"message":"failed"}],"data":null}`, `{"success":true,"detection":{"stationId":99}}`, `{"data":{"station":{"id":"99"}}}`, `<html>down</html>`, `{"success":true} {"extra":true}`} {
		t.Run(body, func(t *testing.T) {
			client, store := testClient(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) })
			_, err := client.Do(context.Background(), birdweather.Request{Operation: "rest:stats", Path: "/api/v1/stations/42/stats", Method: "GET"})
			if err == nil {
				t.Fatal("invalid response accepted")
			}
			stats, _ := store.Stats(context.Background())
			if stats.Responses != 0 || stats.Snapshots != 0 {
				t.Fatal("invalid response persisted")
			}
		})
	}
}

func TestRewriteIsStationConfinedAndRemovesActionCredentials(t *testing.T) {
	client, store := testClient(t, func(http.ResponseWriter, *http.Request) { t.Fatal("rewrite should not fetch") })
	result, err := client.Rewrite([]byte(`{"audioUrl":"https://media.birdweather.com/soundscapes/42/clip.flac","imageUrl":"https://media.birdweather.com/species/7.jpg","foreign":"https://media.birdweather.com/soundscapes/99/clip.flac","favoriteUrl":"https://example.org/private-token","coords":{"lat":10,"lon":20},"shortlist":[{"speciesId":"7"}]}`), false)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	json.Unmarshal(result, &value)
	if !strings.HasPrefix(value["audioUrl"].(string), "/media/") || !strings.HasPrefix(value["imageUrl"].(string), "/media/") {
		t.Fatal("media not rewritten")
	}
	if _, ok := value["favoriteUrl"]; ok {
		t.Fatal("action URL exposed")
	}
	if value["coords"] != nil {
		t.Fatal("precise location exposed")
	}
	stats, _ := store.Stats(context.Background())
	if stats.RegisteredMedia != 2 {
		t.Fatal("foreign media registered", stats)
	}
	for _, raw := range []string{"http://media.birdweather.com/species/7.jpg", "https://media.birdweather.com@127.0.0.1/species/a", "https://media.birdweather.com:443/species/a", "https://media.birdweather.com/species/../soundscapes/99/a", "https://media.birdweather.com/species/a?token=secret", "https://media.birdweather.com/species/%2e%2e/a", "file:///etc/passwd"} {
		if _, _, ok := client.mediaKind(raw); ok {
			t.Error("unsafe source accepted", raw)
		}
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestMediaSavedOnceAndSignatureChecked(t *testing.T) {
	client, store := testClient(t, func(http.ResponseWriter, *http.Request) {})
	var calls atomic.Int32
	client.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader("fLaCfull-original"))}, nil
	})}
	id, _ := store.RegisterMedia("https://media.birdweather.com/soundscapes/42/a.flac", "audio")
	for range 2 {
		media, err := client.Media(context.Background(), id)
		if err != nil || media.Size != 17 || media.ContentType != "audio/flac" {
			t.Fatalf("bad media: %+v %v", media, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("download repeated")
	}
	if _, err := client.Media(context.Background(), archive.Hash([]byte("unknown"))); err == nil {
		t.Fatal("unregistered media accepted")
	}
	if _, err := mediaType("audio", []byte("<html>bad</html>"), "audio/flac"); err == nil {
		t.Fatal("HTML accepted as audio")
	}
}

func TestCanonicalQueriesAndTokenDoNotLeak(t *testing.T) {
	client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/stations/server-only-token/stats" {
			t.Error("token was not used on backend")
		}
		io.WriteString(w, `{"success":true,"species":1,"detections":1}`)
	})
	client.Token = "server-only-token"
	response, err := client.Do(context.Background(), birdweather.Request{Operation: "rest:stats", Path: "/api/v1/stations/42/stats", Method: "GET", Query: url.Values{"period": {"day"}}, FreshFor: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(response.Body), client.Token) {
		t.Fatal("token leaked")
	}
}
