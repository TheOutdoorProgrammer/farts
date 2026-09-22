package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TheOutdoorProgrammer/farts/internal/birdweather"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	htmlparser "golang.org/x/net/html"
)

func previewMetadata(t *testing.T, page string) map[string]string {
	t.Helper()
	root, err := htmlparser.Parse(strings.NewReader(page))
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]string{}
	var visit func(*htmlparser.Node)
	visit = func(node *htmlparser.Node) {
		if node.Type == htmlparser.ElementNode && (node.Data == "meta" || node.Data == "link") {
			attributes := map[string]string{}
			for _, attribute := range node.Attr {
				attributes[attribute.Key] = attribute.Val
			}
			key, value := attributes["property"], attributes["content"]
			if key == "" {
				key = attributes["name"]
			}
			if node.Data == "link" && attributes["rel"] == "canonical" {
				key, value = "canonical", attributes["href"]
			}
			if key != "" {
				if _, exists := result[key]; exists {
					t.Fatalf("duplicate metadata %s", key)
				}
				result[key] = value
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(root)
	return result
}

func TestStationPreviewMetadataWithoutJavaScript(t *testing.T) {
	s := testServer(t)
	s.config.Version = "test-release"
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "http://spoofed.invalid/?view=activity&period=month&classification=bat&from=2026-09-01&to=2026-09-21&speciesId=123&query=red+bat&utm_source=tracker&redirect=https://evil.invalid", nil)
	r.Header.Set("User-Agent", "Twitterbot/1.0")
	r.Header.Set("X-Forwarded-Host", "spoofed.invalid")
	s.Handler().ServeHTTP(w, r)
	meta := previewMetadata(t, w.Body.String())
	canonical := "https://recordings.example.com/?classification=bat&from=2026-09-01&period=month&query=red+bat&speciesId=123&to=2026-09-21&view=activity"
	for key, want := range map[string]string{"canonical": canonical, "og:url": canonical, "og:type": "website", "og:image:type": "image/png", "og:image:width": "1200", "og:image:height": "630", "twitter:card": "summary_large_image", "og:site_name": "FARTS"} {
		if meta[key] != want {
			t.Errorf("%s: got %q, want %q", key, meta[key], want)
		}
	}
	for _, key := range []string{"og:title", "og:description", "og:image", "og:image:alt"} {
		if meta[key] == "" || meta[key] != meta[strings.Replace(key, "og:", "twitter:", 1)] {
			t.Errorf("missing or inconsistent %s", key)
		}
	}
	if !strings.Contains(meta["og:image"], "/og/station.png?") || strings.Contains(w.Body.String(), "spoofed.invalid") || strings.Contains(w.Body.String(), "utm_source") {
		t.Fatal("unsafe preview origin or query")
	}
	if !strings.Contains(meta["og:image:alt"], brandExpansion) {
		t.Fatal("wrong brand expansion")
	}
}

func TestRecordingPreviewTimeZoneAndEscaping(t *testing.T) {
	s := testServer(t)
	s.config.Timezone = "America/New_York"
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/recordings/123?period=all&query=ignored", nil)
	s.html(w, r, map[string]any{"commonName": `Bat"><script>alert(1)</script>`, "timestamp": "2026-09-21T07:23:00Z", "classification": "bat", "imageUrl": "https://evil.invalid/photo.jpg"})
	meta := previewMetadata(t, w.Body.String())
	if strings.Contains(w.Body.String(), "<script>") || strings.Contains(w.Body.String(), "evil.invalid") {
		t.Fatal("upstream injection")
	}
	if meta["date"] != "2026-09-21T03:23:00-04:00" || !strings.Contains(meta["og:description"], "3:23 AM EDT") || !strings.Contains(meta["og:description"], "slowed 10×") {
		t.Fatal("recording time or listening mode missing", meta)
	}
	if meta["canonical"] != "https://recordings.example.com/recordings/123" || meta["og:image"] != "https://recordings.example.com/og/recordings/123.png" {
		t.Fatal("incorrect recording canonical", meta)
	}
	if meta["og:audio"] != "" || meta["twitter:player"] != "" {
		t.Fatal("unsupported player advertised")
	}
}

func TestPreviewImageURLsFollowReleaseVersion(t *testing.T) {
	s := testServer(t)
	for _, release := range []string{"0.1.1", "0.1.2"} {
		s.config.Version = release
		for _, target := range []string{"/?classification=bird", "/recordings/123"} {
			var recording map[string]any
			if strings.HasPrefix(target, "/recordings/") {
				recording = map[string]any{"commonName": "Blue Jay"}
			}
			p := s.preview(httptest.NewRequest("GET", target, nil), recording)
			imageURL, err := url.Parse(p.ImageURL)
			if err != nil || imageURL.Query().Get("v") != release || strings.Contains(p.Canonical, "v=") {
				t.Fatalf("image version leaked into canonical or was omitted: %+v", p)
			}
		}
	}
}

func TestCanonicalQueryRejectsInvalidAndOversizedValues(t *testing.T) {
	input := url.Values{"view": {"<script>"}, "period": {"forever"}, "classification": {"fish"}, "speciesId": {"-1"}, "from": {"2026-02-30"}, "to": {"2026-09-21T00:00:00Z"}, "query": {strings.Repeat("a", 161)}, "token": {"private"}}
	if len(canonicalQuery(input)) != 0 {
		t.Fatal("unsafe parameters retained")
	}
	input.Set("query", "bat\nrecordings")
	if len(canonicalQuery(input)) != 0 {
		t.Fatal("control characters retained")
	}
}

func TestNoConfiguredOriginDoesNotTrustRequestHost(t *testing.T) {
	s := testServer(t)
	s.config.PublicURL = ""
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "https://untrusted.invalid/", nil))
	meta := previewMetadata(t, w.Body.String())
	for _, key := range []string{"canonical", "og:url", "og:image", "twitter:image"} {
		if meta[key] != "" {
			t.Fatal("request host used for public origin", key)
		}
	}
}

type previewTransport struct {
	wrongStation    bool
	stationTimezone string
	photo           map[string]any
	ranking         []any
}

func (transport previewTransport) Do(_ context.Context, request birdweather.Request) (birdweather.Response, error) {
	if request.Operation == "graphql:station" && transport.stationTimezone != "" {
		body, _ := json.Marshal(map[string]any{"data": map[string]any{"station": map[string]any{"id": "42", "name": "Live station", "timezone": transport.stationTimezone}}})
		return birdweather.Response{Body: body, FetchedAt: time.Now()}, nil
	}
	if request.Operation == "graphql:species" && transport.ranking != nil {
		body, _ := json.Marshal(map[string]any{"data": map[string]any{"topSpecies": transport.ranking}})
		return birdweather.Response{Body: body, FetchedAt: time.Now()}, nil
	}
	if request.Operation != "rest:detections" {
		return birdweather.Response{}, errors.New("optional enrichment unavailable")
	}
	station := "42"
	if transport.wrongStation {
		station = "999"
	}
	species := map[string]any{"id": "7", "commonName": "Eastern Red Bat", "scientificName": "Lasiurus borealis", "classification": "bat"}
	for key, value := range transport.photo {
		species[key] = value
	}
	body, _ := json.Marshal(map[string]any{"success": true, "detection": map[string]any{"id": "123", "stationId": station, "timestamp": "2026-09-21T07:23:00Z", "confidence": 0.9, "species": species}})
	return birdweather.Response{Body: body, FetchedAt: time.Now()}, nil
}

type previewRoundTrip func(*http.Request) (*http.Response, error)

func (f previewRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func previewPhotoFixture(t *testing.T, jpegImage bool) []byte {
	t.Helper()
	photo := image.NewRGBA(image.Rect(0, 0, 128, 96))
	draw.Draw(photo, photo.Bounds(), image.NewUniform(color.RGBA{176, 45, 92, 255}), image.Point{}, draw.Src)
	draw.Draw(photo, image.Rect(64, 0, 128, 96), image.NewUniform(color.RGBA{31, 148, 215, 255}), image.Point{}, draw.Src)
	var body bytes.Buffer
	var err error
	if jpegImage {
		err = jpeg.Encode(&body, photo, &jpeg.Options{Quality: 95})
	} else {
		err = png.Encode(&body, photo)
	}
	if err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func savedPreviewPhoto(t *testing.T, s *Server, source, kind, contentType string, body []byte) string {
	t.Helper()
	id, err := s.store.RegisterMedia(source, kind)
	if err != nil {
		t.Fatal(err)
	}
	media, err := s.store.Media(id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.SaveMedia(context.Background(), media, bytes.NewReader(body), contentType, int64(len(body)+1)); err != nil {
		t.Fatal(err)
	}
	return "/media/" + id
}

func creditedPreviewPhoto(source string) map[string]any {
	return map[string]any{"id": "7", "commonName": "Eastern Red Bat", "imageUrl": source, "imageCredit": "Wildlife Photographer", "imageLicense": "CC BY 4.0", "imageSource": "https://example.org/photographer", "imageLicenseUrl": "https://creativecommons.org/licenses/by/4.0/"}
}

func assertPreviewPhotoPixels(t *testing.T, data []byte) {
	t.Helper()
	card, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	left := color.RGBAModel.Convert(card.At(777, 250)).(color.RGBA)
	right := color.RGBAModel.Convert(card.At(1060, 250)).(color.RGBA)
	if left.R < 160 || left.G > 60 || left.B < 70 || right.R > 50 || right.G < 130 || right.B < 190 {
		t.Fatalf("card does not contain the source photograph: left=%v right=%v", left, right)
	}
	if card.Bounds() != image.Rect(0, 0, 1200, 630) {
		t.Fatal("preview dimensions changed")
	}
}

func TestRecordingPreviewRendersArchivedPhotoAndCredits(t *testing.T) {
	for _, jpegImage := range []bool{false, true} {
		s := testServer(t)
		source := "https://media.birdweather.com/species/7/bat.jpg"
		contentType := "image/png"
		if jpegImage {
			contentType = "image/jpeg"
		}
		savedPreviewPhoto(t, s, source, "image", contentType, previewPhotoFixture(t, jpegImage))
		photo := creditedPreviewPhoto(source)
		s.api = birdweather.New("42", previewTransport{photo: photo})
		s.upstream.HTTP.Transport = previewRoundTrip(func(*http.Request) (*http.Response, error) {
			t.Error("archived photo unexpectedly fetched again")
			return nil, errors.New("network unavailable")
		})
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/og/recordings/123.png", nil))
		if w.Code != 200 {
			t.Fatalf("preview failed: %d %s", w.Code, w.Body.String())
		}
		assertPreviewPhotoPixels(t, w.Body.Bytes())
		p := preview{}
		if !s.previewPhoto(context.Background(), &p, photo) || p.PhotoCredit != "Wildlife Photographer" || p.PhotoLicense != "CC BY 4.0" {
			t.Fatal("photo attribution was lost")
		}
		withoutCredit, _ := renderPreview(preview{Photo: p.Photo, PhotoName: p.PhotoName})
		withCredit, _ := renderPreview(p)
		first, _ := png.Decode(bytes.NewReader(withoutCredit))
		second, _ := png.Decode(bytes.NewReader(withCredit))
		changed := 0
		for y := 550; y < 630; y++ {
			for x := 660; x < 1180; x++ {
				if first.At(x, y) != second.At(x, y) {
					changed++
				}
			}
		}
		if changed < 100 {
			t.Fatal("creator and license are missing from visible card pixels")
		}
		conditional := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/og/recordings/123.png", nil)
		request.Header.Set("If-None-Match", w.Header().Get("ETag"))
		s.Handler().ServeHTTP(conditional, request)
		if conditional.Code != 304 || conditional.Body.Len() != 0 {
			t.Fatal("photo card cache validation failed")
		}
	}
}

func TestStationPreviewSelectsCreditedStationSpeciesPhoto(t *testing.T) {
	s := testServer(t)
	photo := creditedPreviewPhoto("https://media.birdweather.com/species/7/bat.png")
	savedPreviewPhoto(t, s, photo["imageUrl"].(string), "image", "image/png", previewPhotoFixture(t, false))
	missing := map[string]any{"id": "8", "commonName": "Uncredited Bird", "imageUrl": "https://media.birdweather.com/species/8/bird.png"}
	s.api = birdweather.New("42", previewTransport{stationTimezone: "UTC", ranking: []any{
		map[string]any{"speciesId": "8", "count": 10, "species": missing},
		map[string]any{"speciesId": "7", "count": 5, "species": photo},
	}})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/og/station.png", nil))
	if w.Code != 200 {
		t.Fatalf("station preview failed: %d", w.Code)
	}
	assertPreviewPhotoPixels(t, w.Body.Bytes())
}

func TestPreviewPhotoFetchReusesValidatedArchiveMedia(t *testing.T) {
	s := testServer(t)
	s.config.MaxMediaBytes, s.upstream.MaxMediaBytes = 1<<20, 1<<20
	source := "https://media.birdweather.com/species/7/bat.jpg"
	s.api = birdweather.New("42", previewTransport{photo: creditedPreviewPhoto(source)})
	var requests atomic.Int32
	body := previewPhotoFixture(t, true)
	s.upstream.HTTP.Transport = previewRoundTrip(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		if r.URL.String() != source {
			t.Errorf("unexpected media source: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{"Content-Type": {"image/jpeg"}}, ContentLength: int64(len(body))}, nil
	})
	for range 2 {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/og/recordings/123.png", nil))
		if w.Code != 200 {
			t.Fatalf("photo preview failed: %d", w.Code)
		}
		assertPreviewPhotoPixels(t, w.Body.Bytes())
	}
	if requests.Load() != 1 {
		t.Fatalf("expected one persisted photo fetch, got %d", requests.Load())
	}
}

func TestPreviewPhotoRejectsUnsafeMissingAndUndecodableImages(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*testing.T, *Server, map[string]any)
	}{
		{"missing credit", func(_ *testing.T, _ *Server, photo map[string]any) { delete(photo, "imageCredit") }},
		{"missing license", func(_ *testing.T, _ *Server, photo map[string]any) { delete(photo, "imageLicense") }},
		{"missing image", func(_ *testing.T, _ *Server, photo map[string]any) { photo["imageUrl"] = nil }},
		{"arbitrary remote URL", func(_ *testing.T, _ *Server, photo map[string]any) {
			photo["imageUrl"] = "https://evil.invalid/animal.png"
		}},
		{"unregistered media", func(_ *testing.T, _ *Server, photo map[string]any) {
			photo["imageUrl"] = "/media/" + strings.Repeat("a", 64)
		}},
		{"audio instead of image", func(t *testing.T, s *Server, photo map[string]any) {
			photo["imageUrl"] = savedPreviewPhoto(t, s, "https://media.birdweather.com/soundscapes/42/bat.flac", "audio", "audio/flac", []byte("fLaC000000000"))
		}},
		{"corrupt image", func(t *testing.T, s *Server, photo map[string]any) {
			photo["imageUrl"] = savedPreviewPhoto(t, s, photo["imageUrl"].(string), "image", "image/png", []byte("invalid cached image"))
		}},
		{"unsupported AVIF", func(t *testing.T, s *Server, photo map[string]any) {
			photo["imageUrl"] = savedPreviewPhoto(t, s, photo["imageUrl"].(string), "image", "image/avif", []byte("\x00\x00\x00\x20ftypavif\x00\x00\x00\x00"))
		}},
		{"excessive decoded dimensions", func(t *testing.T, s *Server, photo map[string]any) {
			body := previewPhotoFixture(t, false)
			binary.BigEndian.PutUint32(body[16:20], 5_000)
			binary.BigEndian.PutUint32(body[29:33], crc32.ChecksumIEEE(body[12:29]))
			photo["imageUrl"] = savedPreviewPhoto(t, s, photo["imageUrl"].(string), "image", "image/png", body)
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			s := testServer(t)
			photo := creditedPreviewPhoto("https://media.birdweather.com/species/7/bat.png")
			test.mutate(t, s, photo)
			s.upstream.HTTP.Transport = previewRoundTrip(func(*http.Request) (*http.Response, error) {
				t.Error("invalid photo triggered remote access")
				return nil, errors.New("unexpected network request")
			})
			p := preview{Heading: "Eastern Red Bat"}
			if s.previewPhoto(context.Background(), &p, photo) || p.Photo != nil {
				t.Fatal("unsafe photo accepted")
			}
			body, err := renderPreview(p)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := png.DecodeConfig(bytes.NewReader(body)); err != nil {
				t.Fatal("fallback card unavailable", err)
			}
		})
	}
}

func TestPreviewPNGRoutesAndConditionalRequests(t *testing.T) {
	s := testServer(t)
	s.api = birdweather.New("42", previewTransport{})
	s.config.StationName = "StoutBats"
	s.config.Timezone = "America/New_York"
	h := s.Handler()
	for _, target := range []string{"/og/station.png", "/og/recordings/123.png"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		image, err := png.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
		if w.Code != 200 || err != nil || image.Width != 1200 || image.Height != 630 || w.Body.Len() > 150000 {
			t.Fatalf("invalid bounded PNG %s: %d %d %v", target, w.Code, w.Body.Len(), err)
		}
		if w.Header().Get("Content-Type") != "image/png" || w.Header().Get("ETag") == "" || w.Header().Get("Cross-Origin-Resource-Policy") != "cross-origin" || !strings.Contains(w.Header().Get("Cache-Control"), "max-age=3600") {
			t.Fatal("missing image cache/embed headers")
		}
		if dir := os.Getenv("FARTS_PREVIEW_ARTIFACT_DIR"); dir != "" {
			if err := os.WriteFile(filepath.Join(dir, filepath.Base(target)), w.Body.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
		}
		request := httptest.NewRequest("GET", target, nil)
		request.Header.Set("If-None-Match", w.Header().Get("ETag"))
		conditional := httptest.NewRecorder()
		h.ServeHTTP(conditional, request)
		if conditional.Code != 304 || conditional.Body.Len() != 0 {
			t.Fatal("conditional image request failed")
		}
		head := httptest.NewRecorder()
		h.ServeHTTP(head, httptest.NewRequest("HEAD", target, nil))
		if head.Code != 200 || head.Body.Len() != 0 || head.Header().Get("Content-Length") == "" {
			t.Fatal("image HEAD failed")
		}
	}
	for _, target := range []string{"/og/recordings/0.png", "/og/recordings/123", "/og/recordings/bad.png"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != 404 {
			t.Fatal("invalid card accepted", target, w.Code)
		}
	}
	s.api = birdweather.New("42", previewTransport{wrongStation: true})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/og/recordings/123.png", nil))
	if w.Code != 404 {
		t.Fatal("foreign station card accepted", w.Code)
	}
}

func TestPreviewImagesShareGlobalAndRenderConcurrencyBounds(t *testing.T) {
	for _, render := range []bool{false, true} {
		s := testServer(t)
		budget := s.concurrency
		if render {
			budget = s.previewConcurrency
		}
		for range cap(budget) {
			budget <- struct{}{}
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/og/station.png", nil))
		if w.Code != 503 || w.Header().Get("Retry-After") == "" {
			t.Fatal("preview bypassed concurrency bound")
		}
	}
}

func TestPreviewUsesStationTimezoneOrPreservesRecordingOffset(t *testing.T) {
	for _, test := range []struct{ timezone, date, description string }{
		{"America/New_York", "2026-09-21T00:23:00-04:00", "12:23 AM EDT"},
		{"", "2026-09-20T21:23:00-07:00", "9:23 PM UTC-07:00"},
	} {
		s := testServer(t)
		s.config.Timezone = ""
		s.api = birdweather.New("42", previewTransport{stationTimezone: test.timezone})
		p := s.preview(httptest.NewRequest("GET", "/recordings/123", nil), map[string]any{"commonName": "Bat", "timestamp": "2026-09-20T21:23:00-07:00"})
		if p.Timestamp != test.date || !strings.Contains(p.Description, test.description) {
			t.Fatalf("incorrect station date: %+v", p)
		}
	}
}

func TestPreviewTextFittingKeepsUnicodeInsideCard(t *testing.T) {
	for _, input := range []string{strings.Repeat("Long", 100), "A very long species name with lots of extra words at the end", "Búhos y murciélagos de la montaña"} {
		lines := previewLines(input, basicfont.Face7x13, 140, 2)
		if len(lines) > 2 {
			t.Fatal("too many lines")
		}
		for _, line := range lines {
			if font.MeasureString(basicfont.Face7x13, line).Ceil() > 140 {
				t.Fatal("text overflows card", line)
			}
		}
	}
}
