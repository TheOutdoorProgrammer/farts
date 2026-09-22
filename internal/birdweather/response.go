package birdweather

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ValidateResponse runs before persistence so an invalid HTTP 200 cannot poison a durable snapshot.
func ValidateResponse(request Request, body []byte, stationID string) error {
	if !validID(stationID) {
		return fmt.Errorf("%w: station configuration", ErrInvalidRequest)
	}
	if len(body) == 0 || len(body) > maxResponseBytes {
		return fmt.Errorf("%w: response size", ErrUpstream)
	}
	envelope, err := objectJSON(body)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var document any
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("%w: JSON", ErrUpstream)
	}
	if err := (&Client{stationID: stationID}).checkStations(document); err != nil {
		return err
	}
	if request.Path == "/graphql" {
		if raw, exists := envelope["errors"]; exists && string(raw) != "null" {
			var failures []json.RawMessage
			if json.Unmarshal(raw, &failures) != nil || len(failures) != 0 {
				return fmt.Errorf("%w: query failed", ErrUpstream)
			}
		}
		data, err := objectJSON(envelope["data"])
		if err != nil {
			return err
		}
		return validateGraphQL(request, data, stationID)
	}
	var success bool
	if json.Unmarshal(envelope["success"], &success) != nil || !success {
		return fmt.Errorf("%w: operation failed", ErrUpstream)
	}
	return validateREST(request, envelope, stationID)
}

func objectJSON(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, fmt.Errorf("%w: object expected", ErrUpstream)
	}
	return object, nil
}

func arrayJSON(raw json.RawMessage, limit int) ([]json.RawMessage, error) {
	var values []json.RawMessage
	if json.Unmarshal(raw, &values) != nil || values == nil || len(values) > limit {
		return nil, fmt.Errorf("%w: array expected", ErrUpstream)
	}
	return values, nil
}

func recordIdentity(raw json.RawMessage, expectedID, stationID string, requireStation bool) error {
	var record struct {
		ID        identifier `json:"id"`
		StationID identifier `json:"stationId"`
	}
	if json.Unmarshal(raw, &record) != nil || !validID(string(record.ID)) || expectedID != "" && string(record.ID) != expectedID {
		return fmt.Errorf("%w: record identity", ErrUpstream)
	}
	if requireStation && string(record.StationID) != stationID {
		return ErrWrongStation
	}
	return nil
}

func countValue(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] < '0' || raw[0] > '9' {
		return false
	}
	var count json.Number
	if json.Unmarshal(raw, &count) != nil {
		return false
	}
	n, err := strconv.ParseInt(string(count), 10, 64)
	return err == nil && n >= 0 && n <= (1<<53)-1
}

func validateREST(request Request, envelope map[string]json.RawMessage, stationID string) error {
	operation := strings.TrimPrefix(request.Operation, "rest:")
	last := request.Path[strings.LastIndex(request.Path, "/")+1:]
	detail := validID(last)
	switch operation {
	case "stats":
		if !countValue(envelope["detections"]) || !countValue(envelope["species"]) {
			return fmt.Errorf("%w: statistics", ErrUpstream)
		}
	case "weather":
		if err := recordIdentity(envelope["station"], stationID, stationID, false); err != nil {
			return err
		}
		_, err := objectJSON(envelope["weather"])
		return err
	case "species", "detections", "soundscapes", "global-detection":
		key := operation
		if detail {
			key = map[string]string{"species": "species", "detections": "detection", "soundscapes": "soundscape", "global-detection": "detection"}[operation]
			if err := recordIdentity(envelope[key], last, stationID, operation != "species"); err != nil {
				return err
			}
			if key == "detection" {
				_, err := normalizeRecording(envelope[key], stationID)
				return err
			}
			if key == "soundscape" {
				return validateSoundscape(envelope[key], stationID)
			}
			return validateSpecies(envelope[key])
		}
		limit := 100
		if value := request.Query.Get("limit"); value != "" {
			limit, _ = strconv.Atoi(value)
		}
		items, err := arrayJSON(envelope[key], limit)
		if err != nil {
			return err
		}
		for _, raw := range items {
			if err := recordIdentity(raw, "", stationID, key != "species"); err != nil {
				return err
			}
			switch key {
			case "detections":
				if _, err := normalizeRecording(raw, stationID); err != nil {
					return err
				}
			case "soundscapes":
				if err := validateSoundscape(raw, stationID); err != nil {
					return err
				}
			case "species":
				if err := validateSpecies(raw); err != nil {
					return err
				}
			}
		}
		if fallback, exists := envelope["unfiltered_detections"]; exists {
			items, err := arrayJSON(fallback, 100)
			if err != nil {
				return err
			}
			for _, item := range items {
				if _, err := normalizeRecording(item, stationID); err != nil {
					return err
				}
			}
		}
	default:
		return fmt.Errorf("%w: response operation", ErrInvalidRequest)
	}
	return nil
}

func validateSoundscape(raw json.RawMessage, stationID string) error {
	var soundscape struct {
		upstreamSoundscape
		Timestamp  string            `json:"timestamp"`
		Filesize   *int64            `json:"filesize"`
		Detections []json.RawMessage `json:"detections"`
	}
	if json.Unmarshal(raw, &soundscape) != nil || soundscape.Filesize == nil || *soundscape.Filesize < 0 || soundscape.URL == nil || nonnegative(soundscape.Duration) == nil {
		return fmt.Errorf("%w: soundscape metadata", ErrUpstream)
	}
	if _, err := time.Parse(time.RFC3339Nano, soundscape.Timestamp); err != nil {
		return fmt.Errorf("%w: soundscape timestamp", ErrUpstream)
	}
	for _, detection := range soundscape.Detections {
		if _, err := normalizeRecording(detection, stationID); err != nil {
			return err
		}
	}
	return nil
}

func validateSpecies(raw json.RawMessage) error {
	var species upstreamSpecies
	if json.Unmarshal(raw, &species) != nil || !validID(string(species.ID)) || cleanText(species.CommonName, 240) == "" {
		return fmt.Errorf("%w: species", ErrUpstream)
	}
	return nil
}

func validateGraphQL(request Request, data map[string]json.RawMessage, stationID string) error {
	operation := strings.TrimPrefix(request.Operation, "graphql:")
	var payload struct {
		Variables map[string]json.RawMessage `json:"variables"`
	}
	if json.Unmarshal(request.Body, &payload) != nil {
		return fmt.Errorf("%w: query variables", ErrInvalidRequest)
	}
	var station map[string]json.RawMessage
	if raw, exists := data["station"]; exists {
		var err error
		station, err = objectJSON(raw)
		if err != nil {
			return err
		}
		var id identifier
		if json.Unmarshal(station["id"], &id) != nil || string(id) != stationID {
			return ErrWrongStation
		}
	}
	switch operation {
	case "station":
		var metadata Station
		if json.Unmarshal(data["station"], &metadata) != nil || metadata.ID != stationID || cleanText(metadata.Name, 240) == "" {
			return fmt.Errorf("%w: station metadata", ErrUpstream)
		}
		if _, err := time.LoadLocation(metadata.Timezone); err != nil {
			return fmt.Errorf("%w: station timezone", ErrUpstream)
		}
	case "detections":
		return validateConnection(data["detections"], payload.Variables, stationID, true)
	case "counts":
		counts, err := objectJSON(data["counts"])
		if err != nil || !countValue(counts["detections"]) || !countValue(counts["species"]) {
			return fmt.Errorf("%w: counts", ErrUpstream)
		}
	case "species", "daily-counts", "time-of-day", "detection-counts":
		key := map[string]string{"species": "topSpecies", "daily-counts": "dailyDetectionCounts", "time-of-day": "timeOfDayDetectionCounts", "detection-counts": "detectionCounts"}[operation]
		raw := data[key]
		if operation == "detection-counts" {
			raw = station[key]
		}
		items, err := arrayJSON(raw, 100000)
		if err != nil {
			return err
		}
		for _, item := range items {
			object, err := objectJSON(item)
			if err != nil {
				return err
			}
			countKey := "count"
			if operation == "daily-counts" {
				countKey = "total"
			}
			if !countValue(object[countKey]) {
				return fmt.Errorf("%w: chart count", ErrUpstream)
			}
			if operation == "time-of-day" || operation == "detection-counts" {
				if err := validateBins(object["bins"]); err != nil {
					return err
				}
			}
			if operation == "daily-counts" {
				var date string
				if json.Unmarshal(object["date"], &date) != nil {
					return fmt.Errorf("%w: daily date", ErrUpstream)
				}
				if _, err := time.Parse(time.DateOnly, date); err != nil {
					return fmt.Errorf("%w: daily date", ErrUpstream)
				}
				counts, err := arrayJSON(object["counts"], 100000)
				if err != nil {
					return err
				}
				for _, count := range counts {
					row, err := objectJSON(count)
					if err != nil || !countValue(row["count"]) {
						return fmt.Errorf("%w: daily species count", ErrUpstream)
					}
				}
			}
		}
	case "weather", "sensors", "probabilities":
		if station == nil {
			return fmt.Errorf("%w: station data", ErrUpstream)
		}
		keys := []string{operation}
		if operation == "weather" {
			keys = []string{"weather", "airPollution"}
		}
		for _, key := range keys {
			raw, exists := station[key]
			if !exists {
				return fmt.Errorf("%w: capability data", ErrUpstream)
			}
			if string(raw) != "null" {
				if operation == "probabilities" {
					if _, err := arrayJSON(raw, 100000); err != nil {
						return err
					}
				} else if _, err := objectJSON(raw); err != nil {
					return err
				}
			}
		}
	case "species-lookup":
		lookup, err := objectJSON(data["allSpecies"])
		if err != nil {
			return err
		}
		var ids []string
		if json.Unmarshal(payload.Variables["ids"], &ids) != nil {
			return fmt.Errorf("%w: lookup identifiers", ErrInvalidRequest)
		}
		nodes, err := arrayJSON(lookup["nodes"], len(ids))
		if err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, node := range nodes {
			var species upstreamSpecies
			if json.Unmarshal(node, &species) != nil || !contains(ids, string(species.ID)) || seen[string(species.ID)] {
				return fmt.Errorf("%w: unexpected lookup species", ErrUpstream)
			}
			if err := validateSpecies(node); err != nil {
				return err
			}
			seen[string(species.ID)] = true
		}
	case "species-details", "species-range", "species-counts", "species-probabilities":
		var id string
		key := "speciesId"
		if operation == "species-counts" {
			key = "speciesID"
		}
		if json.Unmarshal(payload.Variables[key], &id) != nil {
			return fmt.Errorf("%w: species identifier", ErrInvalidRequest)
		}
		if err := recordIdentity(data["species"], id, stationID, false); err != nil {
			return err
		}
		if operation == "species-details" {
			return validateSpecies(data["species"])
		}
		if operation == "species-counts" {
			species, _ := objectJSON(data["species"])
			counts, err := objectJSON(species["detectionCounts"])
			if err != nil || !countValue(counts["count"]) {
				return fmt.Errorf("%w: species counts", ErrUpstream)
			}
			return validateBins(counts["bins"])
		}
		if operation == "species-probabilities" {
			species, _ := objectJSON(data["species"])
			if string(species["probabilities"]) == "null" {
				return nil
			}
			probabilities, err := objectJSON(species["probabilities"])
			if err != nil {
				return err
			}
			_, err = arrayJSON(probabilities["locations"], 100000)
			return err
		}
	default:
		if !strings.HasSuffix(operation, "-history") || station == nil {
			return fmt.Errorf("%w: response operation", ErrInvalidRequest)
		}
		if string(station["sensors"]) == "null" {
			return nil
		}
		sensors, err := objectJSON(station["sensors"])
		if err != nil {
			return err
		}
		return validateConnection(sensors[strings.TrimSuffix(operation, "-history")+"History"], payload.Variables, stationID, false)
	}
	return nil
}

func validateBins(raw json.RawMessage) error {
	bins, err := arrayJSON(raw, 100000)
	if err != nil {
		return err
	}
	for _, bin := range bins {
		value, err := objectJSON(bin)
		if err != nil || !countValue(value["count"]) {
			return fmt.Errorf("%w: bin count", ErrUpstream)
		}
		var key any
		if json.Unmarshal(value["key"], &key) != nil {
			return fmt.Errorf("%w: bin key", ErrUpstream)
		}
		switch key := key.(type) {
		case float64:
		case string:
			if cleanText(key, 100) == "" {
				return fmt.Errorf("%w: bin key", ErrUpstream)
			}
		default:
			return fmt.Errorf("%w: bin key", ErrUpstream)
		}
	}
	return nil
}

func validateConnection(raw json.RawMessage, variables map[string]json.RawMessage, stationID string, detections bool) error {
	connection, err := objectJSON(raw)
	if err != nil {
		return err
	}
	limit := 100
	for _, key := range []string{"first", "last"} {
		if value, exists := variables[key]; exists {
			if json.Unmarshal(value, &limit) != nil || limit < 1 || limit > 100 {
				return fmt.Errorf("%w: page size", ErrInvalidRequest)
			}
		}
	}
	nodes, err := arrayJSON(connection["nodes"], limit)
	if err != nil {
		return err
	}
	page, err := objectJSON(connection["pageInfo"])
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, node := range nodes {
		if string(node) == "null" {
			continue
		}
		if detections {
			recording, err := normalizeRecording(node, stationID)
			if err != nil {
				return err
			}
			if seen[recording.ID] {
				return fmt.Errorf("%w: duplicate detection", ErrUpstream)
			}
			seen[recording.ID] = true
		} else if _, err := objectJSON(node); err != nil {
			return err
		}
	}
	for _, direction := range []struct{ flag, cursor, previous string }{{"hasNextPage", "endCursor", "after"}, {"hasPreviousPage", "startCursor", "before"}} {
		var hasPage bool
		if json.Unmarshal(page[direction.flag], &hasPage) != nil {
			return fmt.Errorf("%w: page information", ErrUpstream)
		}
		if hasPage {
			var cursor, previous string
			_ = json.Unmarshal(variables[direction.previous], &previous)
			if json.Unmarshal(page[direction.cursor], &cursor) != nil || cleanText(cursor, 512) == "" || cursor == previous || len(nodes) == 0 {
				return fmt.Errorf("%w: pagination cursor", ErrUpstream)
			}
		}
	}
	return nil
}
