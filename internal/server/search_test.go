package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/TheOutdoorProgrammer/farts/internal/birdweather"
)

func TestFeedSearchHTTP(t *testing.T) {
	species := map[string]any{
		"id": "7", "commonName": "  Little Brown Bat  ", "scientificName": "Myotis lucifugus", "classification": "bat",
		"imageUrl": "https://media.birdweather.com/species/7/photo.jpg", "imageCredit": "Photographer", "imageLicense": "CC BY 2.0",
	}
	for _, test := range []struct {
		name           string
		searchStatus   int
		matches        []any
		status         int
		wantRecordings int
		wantDetections int32
	}{
		{"matched species", http.StatusOK, []any{species}, http.StatusOK, 1, 1},
		{"no matching species", http.StatusOK, []any{}, http.StatusOK, 0, 0},
		{"search upstream failure", http.StatusInternalServerError, nil, http.StatusBadGateway, 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := testServer(t)
			var searches, detections atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/v1/stations/42/species":
					searches.Add(1)
					if r.Method != http.MethodGet || r.URL.Query().Get("query") != "myotis" || r.URL.Query().Get("period") != "all" {
						t.Errorf("unexpected species search: %s %s", r.Method, r.URL)
					}
					if r.URL.Query().Get("classification") != "" {
						t.Error("all classification was forwarded as an upstream filter")
					}
					w.WriteHeader(test.searchStatus)
					if test.searchStatus == http.StatusOK {
						if err := json.NewEncoder(w).Encode(map[string]any{"success": true, "species": test.matches}); err != nil {
							t.Error(err)
						}
					}
				case "/graphql":
					var request struct {
						Query     string `json:"query"`
						Variables struct {
							StationID  string   `json:"stationID"`
							StationIDs []string `json:"stationIDs"`
							SpeciesIDs []string `json:"speciesIds"`
						} `json:"variables"`
					}
					if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&request) != nil {
						t.Error("invalid GraphQL request")
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if strings.Contains(request.Query, "detections(") {
						detections.Add(1)
						if len(request.Variables.StationIDs) != 1 || request.Variables.StationIDs[0] != "42" || len(request.Variables.SpeciesIDs) != 1 || request.Variables.SpeciesIDs[0] != "7" {
							t.Errorf("detections lost station or search confinement: %+v", request.Variables)
						}
						node := map[string]any{"id": "123", "station": map[string]any{"id": "42"}, "timestamp": "2026-09-21T07:23:00Z", "confidence": 0.9, "species": species}
						body := map[string]any{"data": map[string]any{"detections": map[string]any{"nodes": []any{node}, "pageInfo": map[string]any{"hasNextPage": false, "hasPreviousPage": false, "endCursor": nil, "startCursor": nil}}}}
						if err := json.NewEncoder(w).Encode(body); err != nil {
							t.Error(err)
						}
					} else if strings.Contains(request.Query, "station(") && request.Variables.StationID == "42" {
						_, _ = io.WriteString(w, `{"data":{"station":{"id":"42","name":"Test station","timezone":"UTC","earliestDetectionAt":"2026-01-01T00:00:00Z"}}}`)
					} else {
						t.Errorf("unexpected GraphQL request: %+v", request)
						w.WriteHeader(http.StatusBadRequest)
					}
				default:
					t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer remote.Close()
			s.upstream.BaseURL = remote.URL
			s.upstream.HTTP = remote.Client()

			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/feed?classification=all&query=myotis&period=all", nil))
			if w.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", w.Code, test.status, w.Body.String())
			}
			if searches.Load() != 1 || detections.Load() != test.wantDetections {
				t.Fatalf("upstream calls: searches=%d, detections=%d; want 1, %d", searches.Load(), detections.Load(), test.wantDetections)
			}
			if test.status != http.StatusOK {
				var body map[string]json.RawMessage
				if json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body["error"]) == 0 || body["recordings"] != nil {
					t.Fatalf("search failure did not return an error: %s", w.Body.String())
				}
				return
			}
			var feed birdweather.Feed
			if err := json.Unmarshal(w.Body.Bytes(), &feed); err != nil {
				t.Fatal(err)
			}
			if feed.Station.ID != "42" || feed.Recordings == nil || len(feed.Recordings) != test.wantRecordings || feed.NextCursor != nil {
				t.Fatalf("unexpected feed: %s", w.Body.String())
			}
			if len(feed.Recordings) > 0 {
				recording := feed.Recordings[0]
				if recording.ID != "123" || recording.SpeciesID != "7" || recording.CommonName != "Little Brown Bat" || recording.ScientificName != "Myotis lucifugus" || recording.Classification != "bat" || recording.ImageURL == nil || !strings.HasPrefix(*recording.ImageURL, "/media/") {
					t.Fatalf("search recording was not normalized: %+v", recording)
				}
			}
		})
	}
}
