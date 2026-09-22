package birdweather

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
)

func (c *Client) Dashboard(ctx context.Context, params url.Values) (Response, error) {
	query, err := validateParams(params, mergeRules(periodRules, rules{"speciesId": {kind: "id"}, "limit": integer(1, 100), "classification": enum("all", "bird", "bat")}))
	if err != nil {
		return Response{}, err
	}
	if _, err := periodInput(query); err != nil {
		return Response{}, err
	}
	if query.Get("period") == "" && query.Get("count") == "" && query.Get("from") == "" && query.Get("to") == "" {
		query.Set("period", "day")
	}
	station, metadata, err := c.station(ctx)
	if err != nil {
		return Response{}, err
	}
	if (query.Get("from") != "" || query.Get("to") != "") && query.Get("timezone") == "" {
		query.Set("timezone", station.Timezone)
	}
	if query.Get("limit") == "" {
		query.Set("limit", "20")
	}
	type job struct {
		name      string
		operation string
		params    url.Values
		path      []string
	}
	period := make(url.Values)
	for key := range periodRules {
		if value := query.Get(key); value != "" {
			period.Set(key, value)
		}
	}
	filtered := cloneValues(period)
	if species := query.Get("speciesId"); species != "" {
		filtered.Set("speciesId", species)
	}
	counts := cloneValues(filtered)
	classification := query.Get("classification")
	if classification == "bird" {
		classification = "avian"
	}
	if classification == "avian" || classification == "bat" {
		counts.Set("classifications", classification)
	}
	ranking := cloneValues(counts)
	ranking.Set("limit", query.Get("limit"))
	daily := cloneValues(period)
	if species := query.Get("speciesId"); species != "" {
		daily.Set("speciesIds", species)
	}
	jobs := []job{
		{"counts", "counts", counts, []string{"data", "counts"}},
		{"species", "species", ranking, []string{"data", "topSpecies"}},
		{"daily", "daily-counts", daily, []string{"data", "dailyDetectionCounts"}},
		{"timeOfDay", "time-of-day", filtered, []string{"data", "timeOfDayDetectionCounts"}},
		{"weather", "weather", nil, []string{"data", "station"}},
		{"sensors", "sensors", nil, []string{"data", "station", "sensors"}},
	}
	type result struct {
		name     string
		section  Section
		response Response
	}
	results := make(chan result, len(jobs))
	for _, task := range jobs {
		go func(task job) {
			response, err := c.GraphQL(ctx, task.operation, task.params)
			if err != nil {
				results <- result{name: task.name, section: Section{Data: json.RawMessage("null"), Error: "BirdWeather data is currently unavailable."}}
				return
			}
			raw, err := rawField(response.Body, task.path...)
			if err == nil && task.name == "species" {
				raw, err = c.enrichRankingPhotos(ctx, raw)
			}
			if err == nil && (task.name == "daily" || task.name == "timeOfDay") && (classification == "avian" || classification == "bat") {
				raw, err = filterChart(raw, task.name, classification)
			}
			if err == nil && task.name == "weather" {
				var value map[string]json.RawMessage
				err = json.Unmarshal(raw, &value)
				if err == nil {
					delete(value, "id")
					raw, err = json.Marshal(value)
				}
			}
			if err != nil {
				results <- result{name: task.name, section: Section{Data: json.RawMessage("null"), Error: "BirdWeather returned incomplete data."}}
				return
			}
			results <- result{name: task.name, response: response, section: Section{Data: raw, FetchedAt: &response.FetchedAt, Stale: response.Stale}}
		}(task)
	}
	dashboard := Dashboard{Station: station, Sections: make(map[string]Section), FetchedAt: metadata.FetchedAt, Stale: metadata.Stale}
	parts := []Response{metadata}
	for range jobs {
		result := <-results
		dashboard.Sections[result.name] = result.section
		if result.section.Error == "" {
			parts = append(parts, result.response)
			dashboard.Stale = dashboard.Stale || result.response.Stale
			if result.response.FetchedAt.Before(dashboard.FetchedAt) {
				dashboard.FetchedAt = result.response.FetchedAt
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	return encodeResponse(dashboard, parts...)
}

func filterChart(raw json.RawMessage, kind, classification string) (json.RawMessage, error) {
	var rows []map[string]json.RawMessage
	if json.Unmarshal(raw, &rows) != nil {
		return nil, fmt.Errorf("%w: chart rows", ErrUpstream)
	}
	filtered := make([]map[string]json.RawMessage, 0, len(rows))
	for _, row := range rows {
		if kind == "timeOfDay" {
			match, err := speciesClassification(row["species"], classification)
			if err != nil {
				return nil, err
			}
			if match {
				filtered = append(filtered, row)
			}
			continue
		}
		var counts []map[string]json.RawMessage
		if json.Unmarshal(row["counts"], &counts) != nil {
			return nil, fmt.Errorf("%w: daily species counts", ErrUpstream)
		}
		kept := make([]map[string]json.RawMessage, 0, len(counts))
		var total int64
		for _, count := range counts {
			match, err := speciesClassification(count["species"], classification)
			if err != nil {
				return nil, err
			}
			if match {
				var value int64
				if json.Unmarshal(count["count"], &value) != nil || value < 0 || value > (1<<53)-1-total {
					return nil, fmt.Errorf("%w: daily count", ErrUpstream)
				}
				total += value
				kept = append(kept, count)
			}
		}
		row["counts"], _ = json.Marshal(kept)
		row["total"], _ = json.Marshal(total)
		filtered = append(filtered, row)
	}
	return json.Marshal(filtered)
}

func speciesClassification(raw json.RawMessage, expected string) (bool, error) {
	var species struct {
		Classification string `json:"classification"`
	}
	if json.Unmarshal(raw, &species) != nil || species.Classification == "" {
		return false, fmt.Errorf("%w: chart species classification", ErrUpstream)
	}
	return species.Classification == expected, nil
}
