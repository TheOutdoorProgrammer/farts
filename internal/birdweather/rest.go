package birdweather

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

type restOperation struct {
	resource string
	label    string
	params   rules
	detail   bool
}

func restOperations() []restOperation {
	dateRange := rules{"from": {kind: "datetime"}, "to": {kind: "datetime"}}
	filters := rules{"speciesId": {kind: "id"}, "query": textRule(240), "mode": enum(recordingModes...), "locale": textRule(20), "classification": list(classifications...)}
	return []restOperation{
		{"stats", "Station statistics", rules{"period": enum("day", "week", "month", "all"), "since": {kind: "datetime"}, "mode": enum(recordingModes...), "classification": list(classifications...)}, false},
		{"species", "Station species", mergeRules(dateRange, filters, rules{"period": enum("day", "week", "month", "all"), "since": {kind: "datetime"}, "limit": integer(1, 100), "page": integer(1, 100000), "sort": enum("common_name", "scientific_name", "top"), "order": enum("asc", "desc")}), false},
		{"species", "Species reference", rules{}, true},
		{"detections", "Station detections", mergeRules(dateRange, filters, rules{"limit": integer(1, 100), "cursor": {kind: "id"}, "behavior": list(behaviors...), "shortlist": {kind: "bool"}}), false},
		{"detections", "Detection detail", rules{}, true},
		{"soundscapes", "Station soundscapes", mergeRules(dateRange, rules{"limit": integer(1, 100), "cursor": {kind: "id"}, "speciesId": {kind: "id"}, "detections": {kind: "bool"}}), false},
		{"soundscapes", "Soundscape detail", rules{"detections": {kind: "bool"}}, true},
		{"weather", "Station status and PUC weather", rules{}, false},
		{"global-detection", "Global permalink, confined to this station", rules{}, true},
		{"species-lookup", "Species reference batch", rules{"ids": {kind: "ids", maxLen: 1100, required: true}}, false},
	}
}

func (c *Client) REST(ctx context.Context, resource, id string, params url.Values) (Response, error) {
	if !validID(c.stationID) || id != "" && !validID(id) {
		return Response{}, fmt.Errorf("%w: identifier", ErrInvalidRequest)
	}
	var operation *restOperation
	for _, spec := range restOperations() {
		if spec.resource == resource && spec.detail == (id != "") {
			copy := spec
			operation = &copy
			break
		}
	}
	if operation == nil {
		return Response{}, fmt.Errorf("%w: unsupported REST resource", ErrInvalidRequest)
	}
	query, err := validateParams(params, operation.params)
	if err != nil {
		return Response{}, err
	}
	if resource == "species-lookup" {
		response, err := c.GraphQL(ctx, "species-lookup", query)
		if err != nil {
			return Response{}, err
		}
		nodes, err := rawField(response.Body, "data", "allSpecies", "nodes")
		if err != nil {
			return Response{}, err
		}
		return encodeResponse(struct {
			Success bool            `json:"success"`
			Species json.RawMessage `json:"species"`
		}{true, nodes}, response)
	}
	path := "/api/v1/stations/" + c.stationID + "/" + resource
	if resource == "species" && id != "" {
		path = "/api/v1/species"
	}
	if resource == "global-detection" {
		path = "/api/v1/detections"
	}
	if id != "" {
		path += "/" + id
	}
	response, err := c.do(ctx, Request{
		Operation: "rest:" + resource, Method: http.MethodGet, Path: path, Query: query,
		FreshFor: dynamicFreshness, Immutable: id != "" || historical(query),
	}, false)
	if err != nil {
		return Response{}, err
	}
	if id != "" {
		key := map[string]string{"species": "species", "detections": "detection", "global-detection": "detection", "soundscapes": "soundscape"}[resource]
		raw, err := rawField(response.Body, key)
		if err != nil {
			return Response{}, err
		}
		var record struct {
			ID        identifier `json:"id"`
			StationID identifier `json:"stationId"`
		}
		if err := json.Unmarshal(raw, &record); err != nil || string(record.ID) != id {
			return Response{}, fmt.Errorf("%w: detail identifier", ErrUpstream)
		}
		if resource != "species" && string(record.StationID) != c.stationID {
			return Response{}, ErrWrongStation
		}
	} else if resource == "detections" || resource == "soundscapes" || resource == "species" {
		raw, err := rawField(response.Body, resource)
		if err != nil {
			return Response{}, err
		}
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil || items == nil || len(items) > 100 {
			return Response{}, fmt.Errorf("%w: resource list", ErrUpstream)
		}
		if resource != "species" {
			for _, item := range items {
				var record struct {
					StationID identifier `json:"stationId"`
				}
				if json.Unmarshal(item, &record) != nil || string(record.StationID) != c.stationID {
					return Response{}, ErrWrongStation
				}
			}
		}
	}
	return response, nil
}
