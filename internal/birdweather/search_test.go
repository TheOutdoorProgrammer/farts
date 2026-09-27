package birdweather

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func searchFixture(ids ...string) Response {
	species := make([]any, 0, len(ids))
	for _, id := range ids {
		item := speciesFixture()
		item["id"] = id
		species = append(species, item)
	}
	return response(map[string]any{"success": true, "species": species})
}

func TestFeedSearchPreservesFiltersAndPagination(t *testing.T) {
	searchTime := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC)
	var detectionQueries []map[string]any
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
		if req.Operation == "rest:species" {
			want := url.Values{"query": {"vesper"}, "period": {"all"}, "classification": {"bat"}, "limit": {"100"}, "page": {"1"}, "sort": {"common_name"}, "order": {"asc"}}
			if req.Path != "/api/v1/stations/30605/species" || !reflect.DeepEqual(req.Query, want) || req.Immutable {
				t.Fatalf("wrong species search: %+v", req)
			}
			result := searchFixture("17662", "17282")
			result.FetchedAt, result.Stale = searchTime, true
			return result, nil
		}
		if req.Operation == "graphql:detections" {
			var payload struct {
				Query     string         `json:"query"`
				Variables map[string]any `json:"variables"`
			}
			if err := json.Unmarshal(req.Body, &payload); err != nil {
				t.Fatal(err)
			}
			detectionQueries = append(detectionQueries, payload.Variables)
			if strings.Contains(string(req.Body), "vesper") || !strings.Contains(payload.Query, "stationIds:$stationIDs") {
				t.Fatalf("search escaped typed station filters: %s", req.Body)
			}
			return response(map[string]any{"data": map[string]any{"detections": pageFixture([]any{detectionFixture()}, len(detectionQueries) == 1)}}), nil
		}
		return graphqlFixture(req), nil
	}}
	client := New("30605", transport)
	params := url.Values{"classification": {"bat"}, "query": {" vesper "}, "from": {"2026-09-01"}, "to": {"2026-09-21"}, "confidenceGte": {"0.5"}}
	for page := 0; page < 2; page++ {
		result, err := client.Feed(context.Background(), params)
		if err != nil {
			t.Fatal(err)
		}
		var feed Feed
		if err := json.Unmarshal(result.Body, &feed); err != nil {
			t.Fatal(err)
		}
		if len(feed.Recordings) != 1 || !feed.Stale || !result.Stale || !feed.FetchedAt.Equal(searchTime) || !result.FetchedAt.Equal(searchTime) {
			t.Fatalf("lost search provenance: %+v / %+v", feed, result)
		}
		if page == 0 {
			if feed.NextCursor == nil || *feed.NextCursor != "next-page" {
				t.Fatal("missing search continuation", feed.NextCursor)
			}
			params.Set("cursor", *feed.NextCursor)
		} else if feed.NextCursor != nil {
			t.Fatal("final search page has a cursor")
		}
	}
	for i, variables := range detectionQueries {
		if fmt.Sprint(variables["speciesIds"]) != "[17282 17662]" || fmt.Sprint(variables["classifications"]) != "[bat]" || variables["confidenceGte"] != 0.5 || fmt.Sprint(variables["stationIDs"]) != "[30605]" {
			t.Fatalf("lost detection filters: %+v", variables)
		}
		period := variables["period"].(map[string]any)
		if period["from"] != "2026-09-01" || period["to"] != "2026-09-21" || period["timezone"] != "America/New_York" {
			t.Fatalf("lost date interval: %+v", period)
		}
		if i == 1 && variables["after"] != "next-page" {
			t.Fatalf("lost search cursor: %+v", variables)
		}
	}
	if params.Get("query") != " vesper " {
		t.Fatal("mutated caller parameters")
	}
}

func TestFeedSearchIntersectsSelectedSpecies(t *testing.T) {
	for _, tc := range []struct {
		name   string
		params url.Values
		want   string
	}{
		{"single", url.Values{"speciesId": {"17662"}}, "[17662]"},
		{"multiple", url.Values{"speciesIds": {"17662,1"}}, "[17662]"},
		{"both", url.Values{"speciesId": {"17662"}, "speciesIds": {"1,17662"}}, "[17662]"},
		{"disjoint", url.Values{"speciesId": {"1"}}, ""},
		{"conflicting", url.Values{"speciesId": {"17662"}, "speciesIds": {"1"}}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var filtered string
			transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
				if req.Operation == "rest:species" {
					if req.Query.Get("speciesId") != tc.params.Get("speciesId") {
						t.Fatal("selected species not passed to lookup")
					}
					return searchFixture("17662", "17282"), nil
				}
				if req.Operation == "graphql:detections" {
					var payload struct{ Variables map[string]any }
					_ = json.Unmarshal(req.Body, &payload)
					filtered = fmt.Sprint(payload.Variables["speciesIds"])
					if _, exists := payload.Variables["speciesId"]; exists {
						t.Fatal("conflicting species arguments sent upstream")
					}
				}
				return graphqlFixture(req), nil
			}}
			tc.params.Set("query", "bat")
			result, err := New("30605", transport).Feed(context.Background(), tc.params)
			if err != nil || filtered != tc.want {
				t.Fatalf("got %q / %v, want %q", filtered, err, tc.want)
			}
			var feed Feed
			_ = json.Unmarshal(result.Body, &feed)
			if tc.want == "" && (feed.Recordings == nil || len(feed.Recordings) != 0 || feed.NextCursor != nil) {
				t.Fatalf("empty search fell back to unfiltered feed: %+v", feed)
			}
		})
	}
}

func TestFeedSearchPagesAllSpeciesAndBoundsExpansion(t *testing.T) {
	for _, total := range []int{0, 51, 100, 101, 1000, 1001} {
		t.Run(strconv.Itoa(total), func(t *testing.T) {
			searchPages, matched := 0, 0
			transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
				if req.Operation == "rest:species" {
					searchPages++
					if req.Query.Get("page") != strconv.Itoa(searchPages) {
						t.Fatal("species page did not advance")
					}
					var ids []string
					for i := (searchPages-1)*100 + 1; i <= min(searchPages*100, total); i++ {
						ids = append(ids, strconv.Itoa(i))
					}
					return searchFixture(ids...), nil
				}
				if req.Operation == "graphql:detections" {
					var payload struct {
						Variables struct {
							SpeciesIDs []string `json:"speciesIds"`
						} `json:"variables"`
					}
					_ = json.Unmarshal(req.Body, &payload)
					matched = len(payload.Variables.SpeciesIDs)
					return response(map[string]any{"data": map[string]any{"detections": pageFixture([]any{}, false)}}), nil
				}
				return graphqlFixture(req), nil
			}}
			_, err := New("30605", transport).Feed(context.Background(), url.Values{"query": {"a"}, "period": {"all"}})
			if total > 1000 {
				if !errors.Is(err, ErrSearchTooBroad) || matched != 0 {
					t.Fatalf("broad search truncated: %d / %v", matched, err)
				}
			} else if err != nil || matched != total {
				t.Fatalf("lost search matches: %d, want %d / %v", matched, total, err)
			}
			if searchPages != total/100+1 {
				t.Fatalf("wrong search page count: %d", searchPages)
			}
		})
	}
}

func TestFeedSearchRejectsInvalidFiltersBeforeLookup(t *testing.T) {
	for _, params := range []url.Values{
		{"query": {"bat", "bird"}},
		{"query": {strings.Repeat("a", 241)}},
		{"query": {"bat\n"}},
		{"query": {"bat"}, "stationIds": {"1"}},
		{"query": {"bat"}, "speciesId": {"bad"}},
		{"query": {"bat"}, "cursor": {strings.Repeat("a", 513)}},
		{"query": {"bat"}, "cursor": {"one"}, "before": {"two"}},
		{"query": {"bat"}, "period": {"week"}, "from": {"2026-09-01"}},
		{"query": {"bat"}, "from": {"2026-09-21"}, "to": {"2026-09-01"}},
		{"query": {"bat"}, "classification": {"fish"}},
	} {
		transport := &testTransport{handler: func(context.Context, Request) (Response, error) {
			t.Fatal("invalid filters reached upstream")
			return Response{}, nil
		}}
		if _, err := New("30605", transport).Feed(context.Background(), params); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid request accepted: %+v / %v", params, err)
		}
	}
}

func TestFeedSearchFailureDoesNotReturnUnfilteredDetections(t *testing.T) {
	for _, duplicate := range []bool{false, true} {
		transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
			if req.Operation != "rest:species" {
				t.Fatal("failed lookup fetched detections")
			}
			if duplicate {
				return searchFixture("17662", "17662"), nil
			}
			return Response{}, ErrUpstream
		}}
		if _, err := New("30605", transport).Feed(context.Background(), url.Values{"query": {"bat"}}); !errors.Is(err, ErrUpstream) {
			t.Fatal("failed search was hidden", err)
		}
	}
}

func TestFeedWhitespaceSearchKeepsOrdinaryFeed(t *testing.T) {
	transport := &testTransport{handler: func(_ context.Context, req Request) (Response, error) {
		if req.Operation == "rest:species" {
			t.Fatal("whitespace triggered a species lookup")
		}
		return graphqlFixture(req), nil
	}}
	if _, err := New("30605", transport).Feed(context.Background(), url.Values{"query": {"   "}}); err != nil {
		t.Fatal(err)
	}
}

func TestFeedSearchKeepsPublicIDListsBounded(t *testing.T) {
	var ids []string
	for i := 1; i <= 51; i++ {
		ids = append(ids, strconv.Itoa(i))
	}
	transport := &testTransport{handler: func(context.Context, Request) (Response, error) {
		t.Fatal("oversized public ID list reached upstream")
		return Response{}, nil
	}}
	client := New("30605", transport)
	params := url.Values{"speciesIds": {strings.Join(ids, ",")}}
	if _, err := client.GraphQL(context.Background(), "detections", params); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("public GraphQL guard changed", err)
	}
	params.Set("query", "bat")
	if _, err := client.Feed(context.Background(), params); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("search bypassed public ID guard", err)
	}
}
