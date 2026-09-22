package birdweather

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type testTransport struct {
	mu      sync.Mutex
	calls   []Request
	handler func(context.Context, Request) (Response, error)
}

func (t *testTransport) Do(ctx context.Context, request Request) (Response, error) {
	t.mu.Lock()
	t.calls = append(t.calls, request)
	t.mu.Unlock()
	return t.handler(ctx, request)
}

func response(value any) Response {
	body, _ := json.Marshal(value)
	return Response{Body: body, FetchedAt: time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)}
}

func stationFixture() map[string]any {
	return map[string]any{"id": "30605", "name": "StoutBats", "timezone": "America/New_York", "type": "puc", "edition": "bat", "coords": map[string]any{"lat": 40, "lon": -80}}
}

func speciesFixture() map[string]any {
	return map[string]any{"id": "17662", "commonName": "Vesper Bats", "scientificName": "Vespertilionidae", "classification": "bat", "imageUrl": "https://media.birdweather.com/species/17662/photo.jpg", "imageCredit": `<bdi><a href="//commons.wikimedia.org/wiki/User:Author">An Author</a></bdi>`, "imageLicense": "CC BY 2.0", "imageLicenseUrl": "https://creativecommons.org/licenses/by/2.0/"}
}

func detectionFixture() map[string]any {
	return map[string]any{
		"id": "11279085131", "stationId": "30605", "station": map[string]any{"id": "30605"},
		"timestamp": "2026-09-21T03:40:23-04:00", "confidence": .6538, "probability": 1.0, "score": 9.0,
		"species": speciesFixture(), "behavior": "Search/Clutter", "behaviorCode": "bat_search_clutter", "behaviorConfidence": 1.0,
		"shortlist":  []any{map[string]any{"speciesId": "17287", "commonName": "Hoary Bat", "scientificName": "Lasiurus cinereus", "weight": .3688}},
		"soundscape": map[string]any{"id": "17175355106", "station": map[string]any{"id": "30605"}, "url": "https://media.birdweather.com/soundscapes/30605/bat.flac", "startTime": nil, "endTime": nil, "sampleRate": 250000, "duration": 6},
	}
}

func pageFixture(nodes []any, next bool) map[string]any {
	return map[string]any{"nodes": nodes, "pageInfo": map[string]any{"hasNextPage": next, "hasPreviousPage": false, "endCursor": "next-page", "startCursor": "first-page"}}
}

func graphqlFixture(request Request) Response {
	operation := strings.TrimPrefix(request.Operation, "graphql:")
	station := stationFixture()
	var data map[string]any
	switch operation {
	case "station":
		data = map[string]any{"station": station}
	case "counts":
		data = map[string]any{"counts": map[string]any{"detections": 3, "species": 2, "stations": 1}}
	case "species":
		data = map[string]any{"topSpecies": []any{map[string]any{"speciesId": "17662", "count": 3, "species": speciesFixture()}}}
	case "daily-counts":
		data = map[string]any{"dailyDetectionCounts": []any{map[string]any{"date": "2026-09-21", "dayOfYear": 264, "total": 3, "counts": []any{}}}}
	case "time-of-day":
		data = map[string]any{"timeOfDayDetectionCounts": []any{map[string]any{"speciesId": "17662", "count": 3, "bins": []any{map[string]any{"key": 3.5, "count": 3}}}}}
	case "detection-counts":
		station["detectionCounts"] = []any{}
		data = map[string]any{"station": station}
	case "detections":
		data = map[string]any{"detections": pageFixture([]any{detectionFixture()}, true)}
	case "weather":
		station["weather"], station["airPollution"] = nil, nil
		data = map[string]any{"station": station}
	case "sensors":
		station["sensors"] = map[string]any{"environment": map[string]any{"timestamp": "2026-09-21T12:00:00Z", "temperature": 17.13}, "system": nil}
		data = map[string]any{"station": station}
	case "probabilities":
		station["probabilities"] = []any{}
		data = map[string]any{"station": station}
	case "species-counts":
		species := speciesFixture()
		species["detectionCounts"] = map[string]any{"speciesId": "17662", "count": 3, "bins": []any{map[string]any{"key": "2026-09-21T03:30:00-04:00", "count": 3}}}
		data = map[string]any{"species": species}
	case "species-probabilities":
		species := speciesFixture()
		species["probabilities"] = map[string]any{"precision": 1, "locations": []any{}}
		data = map[string]any{"species": species}
	case "species-details", "species-range":
		data = map[string]any{"species": speciesFixture()}
	case "species-lookup":
		data = map[string]any{"allSpecies": map[string]any{"nodes": []any{speciesFixture()}}}
	default:
		if strings.HasSuffix(operation, "-history") {
			key := strings.TrimSuffix(operation, "-history") + "History"
			station["sensors"] = map[string]any{key: pageFixture([]any{map[string]any{"timestamp": "2026-09-21T12:00:00Z"}}, false)}
			data = map[string]any{"station": station}
		}
	}
	return response(map[string]any{"data": data})
}

func TestRequestsRejectUnconfinedOrOversizedInputBeforeTransport(t *testing.T) {
	transport := &testTransport{handler: func(context.Context, Request) (Response, error) {
		t.Fatal("invalid request reached transport")
		return Response{}, nil
	}}
	client := New("30605", transport)
	cases := []struct {
		name string
		call func() error
	}{
		{"station override", func() error {
			_, e := client.REST(context.Background(), "stats", "", url.Values{"stationId": {"1"}})
			return e
		}},
		{"path traversal", func() error { _, e := client.REST(context.Background(), "../config", "", nil); return e }},
		{"ID injection", func() error { _, e := client.Recording(context.Background(), "1?stationId=2"); return e }},
		{"repeated parameter", func() error {
			_, e := client.REST(context.Background(), "stats", "", url.Values{"period": {"day", "all"}})
			return e
		}},
		{"oversized page", func() error {
			_, e := client.GraphQL(context.Background(), "detections", url.Values{"first": {"101"}})
			return e
		}},
		{"NaN", func() error {
			_, e := client.GraphQL(context.Background(), "detections", url.Values{"confidenceGte": {"NaN"}})
			return e
		}},
		{"unknown classification", func() error {
			_, e := client.Feed(context.Background(), url.Values{"classification": {"mystery"}})
			return e
		}},
		{"cursor too long", func() error {
			_, e := client.Feed(context.Background(), url.Values{"cursor": {strings.Repeat("a", 513)}})
			return e
		}},
		{"raw document", func() error {
			_, e := client.GraphQL(context.Background(), "counts", url.Values{"query": {"{stations{nodes{id}}}"}})
			return e
		}},
		{"global station IDs", func() error {
			_, e := client.GraphQL(context.Background(), "counts", url.Values{"stationIds": {"1,2"}})
			return e
		}},
		{"mutation", func() error { _, e := client.GraphQL(context.Background(), "updateStation", nil); return e }},
		{"boolean coercion", func() error {
			_, e := client.REST(context.Background(), "soundscapes", "", url.Values{"detections": {"1"}})
			return e
		}},
		{"bad date range", func() error {
			_, e := client.REST(context.Background(), "detections", "", url.Values{"from": {"2026-09-22"}, "to": {"2026-09-21"}})
			return e
		}},
		{"conflicting pagination", func() error {
			_, e := client.GraphQL(context.Background(), "detections", url.Values{"first": {"1"}, "before": {"cursor"}})
			return e
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("got %v, want ErrInvalidRequest", err)
			}
		})
	}
}

func TestFeedNormalizesBatMetadataAndNullableAudio(t *testing.T) {
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) { return graphqlFixture(req), nil }}
	client := New("30605", transport)
	result, err := client.Feed(context.Background(), url.Values{"classification": {"bat"}})
	if err != nil {
		t.Fatal(err)
	}
	var feed Feed
	if err := json.Unmarshal(result.Body, &feed); err != nil {
		t.Fatal(err)
	}
	if feed.Station.ID != "30605" || feed.NextCursor == nil || len(feed.Recordings) != 1 {
		t.Fatalf("invalid feed: %+v", feed)
	}
	recording := feed.Recordings[0]
	if recording.ID != "11279085131" || recording.SpeciesID != "17662" || recording.Confidence != .6538 || recording.Classification != "bat" || recording.StartTime != nil || recording.EndTime != nil {
		t.Fatalf("invalid normalized record: %+v", recording)
	}
	if len(recording.Shortlist) != 1 || recording.Shortlist[0].Weight != .3688 || recording.BehaviorCode == nil || *recording.BehaviorCode != "bat_search_clutter" {
		t.Fatalf("lost bat metadata: %+v", recording)
	}
	if recording.ImageCredit == nil || *recording.ImageCredit != "An Author" || recording.ImageSource == nil || *recording.ImageSource != "https://commons.wikimedia.org/wiki/User:Author" {
		t.Fatalf("invalid attribution: %+v", recording)
	}
	var request struct {
		Variables map[string]any `json:"variables"`
		Query     string         `json:"query"`
	}
	_ = json.Unmarshal(transport.calls[0].Body, &request)
	if fmt.Sprint(request.Variables["stationIDs"]) != "[30605]" || fmt.Sprint(request.Variables["classifications"]) != "[bat]" || request.Variables["first"] != float64(36) || !strings.Contains(request.Query, "stationIds:$stationIDs") {
		t.Fatalf("unconfined query: %s", transport.calls[0].Body)
	}
	if transport.calls[0].Immutable || transport.calls[0].FreshFor != time.Minute {
		t.Fatal("latest page must be dynamic")
	}
}

func TestNormalizationMediaAndNulls(t *testing.T) {
	cases := []struct {
		name   string
		change func(map[string]any)
		check  func(*testing.T, Recording, error)
	}{
		{"missing soundscape", func(d map[string]any) { delete(d, "soundscape") }, func(t *testing.T, r Recording, err error) {
			if err != nil || r.AudioURL != nil || r.SoundscapeID != nil {
				t.Fatalf("got %+v / %v", r, err)
			}
		}},
		{"null soundscape", func(d map[string]any) { d["soundscape"] = nil }, func(t *testing.T, r Recording, err error) {
			if err != nil || r.AudioURL != nil {
				t.Fatalf("got %+v / %v", r, err)
			}
		}},
		{"invalid confidence", func(d map[string]any) { d["confidence"] = 1.1 }, func(t *testing.T, _ Recording, err error) {
			if !errors.Is(err, ErrUpstream) {
				t.Fatalf("got %v", err)
			}
		}},
		{"missing confidence", func(d map[string]any) { delete(d, "confidence") }, func(t *testing.T, _ Recording, err error) {
			if !errors.Is(err, ErrUpstream) {
				t.Fatalf("got %v", err)
			}
		}},
		{"malicious media", func(d map[string]any) {
			d["soundscape"].(map[string]any)["url"] = "https://media.birdweather.com@evil.example/bat.flac"
		}, func(t *testing.T, r Recording, err error) {
			if err != nil || r.AudioURL != nil {
				t.Fatalf("got %+v / %v", r, err)
			}
		}},
		{"another station media", func(d map[string]any) {
			d["soundscape"].(map[string]any)["url"] = "https://media.birdweather.com/soundscapes/999/bat.flac"
		}, func(t *testing.T, r Recording, err error) {
			if err != nil || r.AudioURL != nil {
				t.Fatalf("got %+v / %v", r, err)
			}
		}},
		{"wrong station", func(d map[string]any) { d["station"] = map[string]any{"id": "999"} }, func(t *testing.T, _ Recording, err error) {
			if !errors.Is(err, ErrWrongStation) {
				t.Fatalf("got %v", err)
			}
		}},
		{"unlicensed photo", func(d map[string]any) { delete(d["species"].(map[string]any), "imageLicense") }, func(t *testing.T, r Recording, err error) {
			if err != nil || r.ImageURL != nil {
				t.Fatalf("got %+v / %v", r, err)
			}
		}},
		{"unsafe credit", func(d map[string]any) {
			d["species"].(map[string]any)["imageCredit"] = `<script>evil()</script><a href="javascript:evil()">Author</a>`
		}, func(t *testing.T, r Recording, err error) {
			if err != nil || r.ImageCredit == nil || *r.ImageCredit != "Author" || r.ImageSource != nil {
				t.Fatalf("got %+v / %v", r, err)
			}
		}},
		{"reversed offsets", func(d map[string]any) { s := d["soundscape"].(map[string]any); s["startTime"], s["endTime"] = 5, 2 }, func(t *testing.T, r Recording, err error) {
			if err != nil || r.StartTime != nil || r.EndTime != nil {
				t.Fatalf("got %+v / %v", r, err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			detection := detectionFixture()
			tc.change(detection)
			raw, _ := json.Marshal(detection)
			recording, err := normalizeRecording(raw, "30605")
			tc.check(t, recording, err)
		})
	}
}

func TestDashboardPreservesIndependentSections(t *testing.T) {
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
		if req.Operation == "graphql:daily-counts" {
			return Response{}, errors.New("upstream unavailable")
		}
		result := graphqlFixture(req)
		if req.Operation == "graphql:sensors" {
			result.Stale = true
		}
		return result, nil
	}}
	result, err := New("30605", transport).Dashboard(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var dashboard Dashboard
	if err := json.Unmarshal(result.Body, &dashboard); err != nil {
		t.Fatal(err)
	}
	if len(dashboard.Sections) != 6 || dashboard.Sections["daily"].Error == "" || dashboard.Sections["counts"].Error != "" || string(dashboard.Sections["daily"].Data) != "null" || !dashboard.Stale || !result.Stale {
		t.Fatalf("invalid dashboard: %+v", dashboard)
	}
	var ranks []struct {
		Species struct {
			ImageCredit string `json:"imageCredit"`
		} `json:"species"`
	}
	if json.Unmarshal(dashboard.Sections["species"].Data, &ranks) != nil || len(ranks) != 1 || ranks[0].Species.ImageCredit != "An Author" {
		t.Fatalf("photo attribution not normalized: %s", dashboard.Sections["species"].Data)
	}
	for _, call := range transport.calls {
		if call.Operation == "graphql:detections-history" {
			t.Fatal("broken optional history must not be requested by dashboard")
		}
	}
}

func TestRecordingEnrichmentPreservesOriginalDuration(t *testing.T) {
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
		switch req.Operation {
		case "rest:detections":
			return response(map[string]any{"success": true, "detection": detectionFixture()}), nil
		case "rest:species":
			return response(map[string]any{"success": true, "species": speciesFixture()}), nil
		case "rest:soundscapes":
			return response(map[string]any{"success": true, "soundscape": map[string]any{"id": "17175355106", "stationId": "30605", "timestamp": "2026-09-21T03:40:23-04:00", "url": "https://media.birdweather.com/soundscapes/30605/bat.flac", "duration": 6.0002, "sampleRate": 250000, "filesize": 554778}}), nil
		}
		return Response{}, errors.New("unexpected operation")
	}}
	result, err := New("30605", transport).Recording(context.Background(), "11279085131")
	if err != nil {
		t.Fatal(err)
	}
	var recording Recording
	if json.Unmarshal(result.Body, &recording) != nil || recording.Duration == nil || *recording.Duration != 6.0002 || recording.SampleRate == nil || *recording.SampleRate != 250000 || recording.StartTime != nil {
		t.Fatalf("invalid original metadata: %s", result.Body)
	}
	for _, call := range transport.calls {
		if !call.Immutable {
			t.Fatalf("ID request must be retained: %+v", call)
		}
	}
}

func TestCancellationAndOptionalEnrichmentFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	transport := &testTransport{handler: func(context.Context, Request) (Response, error) {
		t.Fatal("canceled request reached upstream")
		return Response{}, nil
	}}
	if _, err := New("30605", transport).Feed(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	transport.handler = func(_ context.Context, req Request) (Response, error) {
		if req.Operation == "rest:detections" {
			return response(map[string]any{"success": true, "detection": detectionFixture()}), nil
		}
		return Response{}, errors.New("optional reference unavailable")
	}
	if _, err := New("30605", transport).Recording(context.Background(), "11279085131"); err != nil {
		t.Fatal(err)
	}
}

func TestGraphQLPresetCoverageAndStationConfinement(t *testing.T) {
	for _, spec := range graphqlOperations() {
		if spec.name == "species-search" {
			continue
		}
		t.Run(spec.name, func(t *testing.T) {
			transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) { return graphqlFixture(req), nil }}
			params := url.Values{}
			for key, rule := range spec.params {
				if !rule.required {
					continue
				}
				switch key {
				case "speciesId", "ids":
					params.Set(key, "17662")
				case "model":
					params.Set(key, "BIRDNET")
				}
			}
			if _, err := New("30605", transport).GraphQL(context.Background(), spec.name, params); err != nil {
				t.Fatal(err)
			}
			for _, call := range transport.calls {
				var query struct {
					Query     string         `json:"query"`
					Variables map[string]any `json:"variables"`
				}
				if json.Unmarshal(call.Body, &query) != nil {
					t.Fatal("invalid query")
				}
				if call.Method != "POST" || call.Path != "/graphql" || strings.Contains(query.Query, "mutation") || strings.Contains(query.Query, "newDetection") || strings.Contains(query.Query, "latestDetections") || strings.Contains(query.Query, "detectedStations") {
					t.Fatalf("unsafe query: %s", call.Body)
				}
				if value, ok := query.Variables["stationID"]; ok && value != "30605" {
					t.Fatalf("wrong station: %v", value)
				}
				if value, ok := query.Variables["stationIDs"]; ok && fmt.Sprint(value) != "[30605]" {
					t.Fatalf("wrong station: %v", value)
				}
			}
		})
	}
}

func TestExplicitDatesUseStationTimezoneAndPagesAreSnapshots(t *testing.T) {
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) { return graphqlFixture(req), nil }}
	client := New("30605", transport)
	if _, err := client.GraphQL(context.Background(), "counts", url.Values{"from": {"2020-01-01"}, "to": {"2020-01-02"}}); err != nil {
		t.Fatal(err)
	}
	call := transport.calls[len(transport.calls)-1]
	var body struct {
		Variables struct {
			Period struct {
				Timezone string `json:"timezone"`
			} `json:"period"`
		} `json:"variables"`
	}
	_ = json.Unmarshal(call.Body, &body)
	if body.Variables.Period.Timezone != "America/New_York" || !call.Immutable {
		t.Fatalf("incorrect date policy: %s immutable=%v", call.Body, call.Immutable)
	}
	if _, err := client.GraphQL(context.Background(), "environment-history", url.Values{"after": {"old-page"}}); err != nil {
		t.Fatal(err)
	}
	if !transport.calls[len(transport.calls)-1].Immutable {
		t.Fatal("history page must be retained")
	}
}
