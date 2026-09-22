package birdweather

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestResponseValidationRejectsInvalidSuccessBeforePersistence(t *testing.T) {
	request := Request{Operation: "graphql:detections", Path: "/graphql", Body: []byte(`{"variables":{"first":1,"after":"old"}}`)}
	cases := []struct {
		name string
		body func() []byte
	}{
		{"error envelope", func() []byte { return []byte(`{"data":{},"errors":[{"message":"secret upstream detail"}]}`) }},
		{"null data", func() []byte { return []byte(`{"data":null}`) }},
		{"wrong station", func() []byte {
			d := detectionFixture()
			d["station"] = map[string]any{"id": "999"}
			return response(map[string]any{"data": map[string]any{"detections": pageFixture([]any{d}, false)}}).Body
		}},
		{"missing pageInfo", func() []byte {
			return response(map[string]any{"data": map[string]any{"detections": map[string]any{"nodes": []any{detectionFixture()}}}}).Body
		}},
		{"repeated cursor", func() []byte {
			page := pageFixture([]any{detectionFixture()}, true)
			page["pageInfo"].(map[string]any)["endCursor"] = "old"
			return response(map[string]any{"data": map[string]any{"detections": page}}).Body
		}},
		{"empty next page", func() []byte {
			return response(map[string]any{"data": map[string]any{"detections": pageFixture([]any{}, true)}}).Body
		}},
		{"oversized response page", func() []byte {
			return response(map[string]any{"data": map[string]any{"detections": pageFixture([]any{detectionFixture(), detectionFixture()}, false)}}).Body
		}},
		{"invalid timestamp", func() []byte {
			d := detectionFixture()
			d["timestamp"] = "yesterday"
			return response(map[string]any{"data": map[string]any{"detections": pageFixture([]any{d}, false)}}).Body
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateResponse(request, test.body(), "30605")
			if err == nil || strings.Contains(err.Error(), "secret upstream detail") {
				t.Fatalf("unsafe validation result: %v", err)
			}
		})
	}
	good := response(map[string]any{"data": map[string]any{"detections": pageFixture([]any{detectionFixture()}, false)}})
	if err := ValidateResponse(request, good.Body, "30605"); err != nil {
		t.Fatal(err)
	}
}

func TestRESTValidationRejectsFailureMalformedCountsAndWrongDetail(t *testing.T) {
	for _, body := range []string{
		`{"success":false,"detections":1,"species":1}`,
		`{"success":true,"detections":"1","species":1}`,
		`{"success":true,"detections":-1,"species":1}`,
		`{"success":true,"detections":9007199254740992,"species":1}`,
		`{"success":true,"detections":1}`,
	} {
		if err := ValidateResponse(Request{Operation: "rest:stats", Path: "/api/v1/stations/30605/stats"}, []byte(body), "30605"); !errors.Is(err, ErrUpstream) {
			t.Fatalf("accepted malformed statistics: %s / %v", body, err)
		}
	}
	detection := detectionFixture()
	detection["id"] = "11279085132"
	body := response(map[string]any{"success": true, "detection": detection}).Body
	if err := ValidateResponse(Request{Operation: "rest:detections", Path: "/api/v1/stations/30605/detections/11279085131"}, body, "30605"); !errors.Is(err, ErrUpstream) {
		t.Fatalf("accepted mismatched detail: %v", err)
	}
}

func TestReferenceDocumentsAvoidBrokenUpstreamFields(t *testing.T) {
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) { return graphqlFixture(req), nil }}
	client := New("30605", transport)
	for _, operation := range []string{"species-counts", "species-probabilities"} {
		params := url.Values{"speciesId": {"17662"}}
		if operation == "species-probabilities" {
			params.Set("model", "BIRDNET")
		}
		if _, err := client.GraphQL(context.Background(), operation, params); err != nil {
			t.Fatal(err)
		}
		var body struct{ Query string }
		_ = json.Unmarshal(transport.calls[len(transport.calls)-1].Body, &body)
		if !strings.Contains(body.Query, "{id ") || strings.Contains(body.Query, "species { id") || strings.Contains(body.Query, "{speciesId precision") {
			t.Fatalf("broken redundant field restored: %s", body.Query)
		}
	}
}

func TestFeedRESTAttributionFallbackDeduplicatesSpecies(t *testing.T) {
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
		if req.Operation == "graphql:detections" {
			first, second := detectionFixture(), detectionFixture()
			second["id"] = "11279085132"
			for _, detection := range []map[string]any{first, second} {
				detection["species"].(map[string]any)["imageCredit"] = nil
			}
			return response(map[string]any{"data": map[string]any{"detections": pageFixture([]any{first, second}, false)}}), nil
		}
		if req.Operation == "rest:species" {
			species := speciesFixture()
			species["imageCredit"], species["imageCreditHtml"] = nil, `<a href="https://example.org/author">Licensed Author</a>`
			return response(map[string]any{"success": true, "species": species}), nil
		}
		return graphqlFixture(req), nil
	}}
	result, err := New("30605", transport).Feed(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var feed Feed
	_ = json.Unmarshal(result.Body, &feed)
	for _, record := range feed.Recordings {
		if record.ImageURL == nil || record.ImageCredit == nil || *record.ImageCredit != "Licensed Author" || record.ImageSource == nil || *record.ImageSource != "https://example.org/author" {
			t.Fatalf("missing fallback attribution: %+v", record)
		}
	}
	lookups := 0
	for _, request := range transport.calls {
		if request.Operation == "rest:species" {
			lookups++
		}
	}
	if lookups != 1 {
		t.Fatalf("expected one lookup for repeated species, got %d", lookups)
	}
}

func TestAllTimeUsesStationBoundsAndRemainsDynamic(t *testing.T) {
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
		if req.Operation == "graphql:station" {
			station := stationFixture()
			station["earliestDetectionAt"] = "2026-09-01T02:00:00Z"
			return response(map[string]any{"data": map[string]any{"station": station}}), nil
		}
		return graphqlFixture(req), nil
	}}
	if _, err := New("30605", transport).GraphQL(context.Background(), "counts", url.Values{"period": {"all"}}); err != nil {
		t.Fatal(err)
	}
	request := transport.calls[len(transport.calls)-1]
	var payload struct {
		Variables struct {
			Period map[string]any `json:"period"`
		} `json:"variables"`
	}
	_ = json.Unmarshal(request.Body, &payload)
	period := payload.Variables.Period
	zone, _ := time.LoadLocation("America/New_York")
	if period["from"] != "2026-08-31" || period["to"] != time.Now().In(zone).Format(time.DateOnly) || period["timezone"] != "America/New_York" || request.Immutable {
		t.Fatalf("wrong all-time bounds: %s immutable=%v", request.Body, request.Immutable)
	}
}

func TestClassificationChartFilteringRecalculatesDailyTotals(t *testing.T) {
	bat := map[string]any{"speciesId": "17662", "count": 3, "species": map[string]any{"classification": "bat"}}
	bird := map[string]any{"speciesId": "108", "count": 9, "species": map[string]any{"classification": "avian"}}
	input := response([]any{map[string]any{"date": "2026-09-21", "total": 12, "counts": []any{bird, bat}}}).Body
	filtered, err := filterChart(input, "daily", "bat")
	if err != nil {
		t.Fatal(err)
	}
	var daily []struct {
		Total  int               `json:"total"`
		Counts []json.RawMessage `json:"counts"`
	}
	_ = json.Unmarshal(filtered, &daily)
	if len(daily) != 1 || daily[0].Total != 3 || len(daily[0].Counts) != 1 {
		t.Fatalf("wrong filtered totals: %s", filtered)
	}
	input = response([]any{bird, bat}).Body
	filtered, err = filterChart(input, "timeOfDay", "bat")
	if err != nil || strings.Contains(string(filtered), "avian") || !strings.Contains(string(filtered), "17662") {
		t.Fatalf("wrong time-of-day filtering: %s / %v", filtered, err)
	}
	delete(bat, "species")
	if _, err := filterChart(response([]any{bat}).Body, "timeOfDay", "bat"); !errors.Is(err, ErrUpstream) {
		t.Fatalf("missing classification silently accepted: %v", err)
	}
}
