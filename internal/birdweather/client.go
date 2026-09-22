package birdweather

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"time"
)

const (
	dynamicFreshness  = time.Minute
	metadataFreshness = 5 * time.Minute
	maxResponseBytes  = 32 << 20
)

func (c *Client) do(ctx context.Context, req Request, _ bool) (Response, error) {
	if !validID(c.stationID) || c.transport == nil {
		return Response{}, fmt.Errorf("%w: station configuration", ErrInvalidRequest)
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	response, err := c.transport.Do(ctx, req)
	if err != nil {
		return Response{}, err
	}
	if err := ValidateResponse(req, response.Body, c.stationID); err != nil {
		return Response{}, err
	}
	if response.FetchedAt.IsZero() {
		response.FetchedAt = time.Now().UTC()
	}
	return response, nil
}

func (c *Client) checkStations(value any) error {
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			if err := c.checkStations(item); err != nil {
				return err
			}
		}
	case map[string]any:
		if id, ok := v["stationId"]; ok && id != nil && scalarID(id) != c.stationID {
			return ErrWrongStation
		}
		if station, ok := v["station"].(map[string]any); ok {
			if id, exists := station["id"]; exists && scalarID(id) != c.stationID {
				return ErrWrongStation
			}
		}
		for _, item := range v {
			if err := c.checkStations(item); err != nil {
				return err
			}
		}
	}
	return nil
}

func scalarID(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case json.Number:
		return string(v)
	default:
		return ""
	}
}

func encodeResponse(value any, parts ...Response) (Response, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return Response{}, fmt.Errorf("%w: encoding response", ErrUpstream)
	}
	result := Response{Body: body}
	for _, part := range parts {
		if result.FetchedAt.IsZero() || part.FetchedAt.Before(result.FetchedAt) {
			result.FetchedAt = part.FetchedAt
		}
		result.Stale = result.Stale || part.Stale
	}
	if result.FetchedAt.IsZero() {
		result.FetchedAt = time.Now().UTC()
	}
	return result, nil
}

func cloneValues(values url.Values) url.Values {
	copy := make(url.Values, len(values))
	for key, values := range values {
		copy[key] = append([]string(nil), values...)
	}
	return copy
}

func rawField(body json.RawMessage, path ...string) (json.RawMessage, error) {
	current := body
	for _, key := range path {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(current, &object); err != nil {
			return nil, fmt.Errorf("%w: missing response field", ErrUpstream)
		}
		var ok bool
		current, ok = object[key]
		if !ok {
			return nil, fmt.Errorf("%w: missing response field", ErrUpstream)
		}
	}
	return current, nil
}
