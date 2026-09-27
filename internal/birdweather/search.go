package birdweather

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

func (c *Client) feedDetections(ctx context.Context, params url.Values) (Response, error) {
	if values := params["query"]; len(values) == 1 {
		if len(values[0]) > 240 || strings.IndexFunc(values[0], unicode.IsControl) >= 0 {
			return Response{}, fmt.Errorf("%w: search query", ErrInvalidRequest)
		}
		params = cloneValues(params)
		if term := strings.TrimSpace(values[0]); term != "" {
			params.Set("query", term)
		} else {
			params.Del("query")
		}
	}
	if _, search := params["query"]; !search {
		return c.GraphQL(ctx, "detections", params)
	}
	spec := findGraphQLOperation("detections")
	query, err := validateParams(params, mergeRules(spec.params, rules{"query": textRule(240)}))
	if err != nil {
		return Response{}, err
	}
	if _, err := periodInput(query); err != nil {
		return Response{}, err
	}
	search := url.Values{
		"query": {query.Get("query")}, "period": {"all"}, "limit": {"100"},
		"sort": {"common_name"}, "order": {"asc"},
	}
	if classification := query.Get("classifications"); classification != "" {
		search.Set("classification", classification)
	}
	if id := query.Get("speciesId"); id != "" {
		search.Set("speciesId", id)
	}
	ids, parts, err := c.searchSpecies(ctx, search)
	if err != nil {
		return Response{}, err
	}
	var matches []string
	for _, id := range ids {
		if selected := query.Get("speciesId"); selected != "" && selected != id {
			continue
		}
		if selected := query.Get("speciesIds"); selected != "" && !contains(strings.Split(selected, ","), id) {
			continue
		}
		matches = append(matches, id)
	}
	if len(matches) == 0 {
		return encodeResponse(map[string]any{"data": map[string]any{"detections": map[string]any{
			"nodes": []any{}, "pageInfo": map[string]any{"hasNextPage": false, "endCursor": nil},
		}}}, parts...)
	}
	query.Del("query")
	query.Del("speciesId")
	query.Set("speciesIds", strings.Join(matches, ","))
	// Public filters were validated above; station-scoped search may resolve more than 50 IDs.
	response, err := c.graphql(ctx, spec, query)
	if err != nil {
		return Response{}, err
	}
	return encodeResponse(response.Body, append(parts, response)...)
}

func (c *Client) searchSpecies(ctx context.Context, params url.Values) ([]string, []Response, error) {
	const maxMatches = 1000
	seen := map[string]bool{}
	var ids []string
	var parts []Response
	for page := 1; ; page++ {
		params.Set("page", strconv.Itoa(page))
		response, err := c.REST(ctx, "species", "", params)
		if err != nil {
			return nil, nil, err
		}
		parts = append(parts, response)
		raw, err := rawField(response.Body, "species")
		if err != nil {
			return nil, nil, err
		}
		var species []struct {
			ID identifier `json:"id"`
		}
		if json.Unmarshal(raw, &species) != nil {
			return nil, nil, fmt.Errorf("%w: search species", ErrUpstream)
		}
		for _, item := range species {
			id := string(item.ID)
			if seen[id] {
				return nil, nil, fmt.Errorf("%w: repeated search species", ErrUpstream)
			}
			seen[id] = true
			ids = append(ids, id)
			if len(ids) > maxMatches {
				return nil, nil, ErrSearchTooBroad
			}
		}
		if len(species) < 100 {
			sort.Strings(ids)
			return ids, parts, nil
		}
	}
}
