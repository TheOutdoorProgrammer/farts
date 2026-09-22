package birdweather

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"math"
	"net/url"
	"strings"
	"time"
	"unicode"
)

type identifier string

func (id *identifier) UnmarshalJSON(data []byte) error {
	var value string
	if len(data) > 0 && data[0] == '"' {
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
	} else {
		value = string(data)
	}
	if !validID(value) {
		return fmt.Errorf("%w: identifier", ErrUpstream)
	}
	*id = identifier(value)
	return nil
}

type upstreamSpecies struct {
	ID              identifier `json:"id"`
	CommonName      string     `json:"commonName"`
	ScientificName  string     `json:"scientificName"`
	Classification  string     `json:"classification"`
	ImageURL        *string    `json:"imageUrl"`
	ImageCredit     *string    `json:"imageCredit"`
	ImageCreditHTML *string    `json:"imageCreditHtml"`
	ImageCreditURL  *string    `json:"imageCreditUrl"`
	ImageLicense    *string    `json:"imageLicense"`
	ImageLicenseURL *string    `json:"imageLicenseUrl"`
}

type upstreamSoundscape struct {
	ID        identifier `json:"id"`
	StationID identifier `json:"stationId"`
	Station   *struct {
		ID identifier `json:"id"`
	} `json:"station"`
	URL        *string  `json:"url"`
	StartTime  *float64 `json:"startTime"`
	EndTime    *float64 `json:"endTime"`
	Duration   *float64 `json:"duration"`
	SampleRate *int     `json:"sampleRate"`
}

type upstreamDetection struct {
	ID        identifier `json:"id"`
	StationID identifier `json:"stationId"`
	Station   *struct {
		ID identifier `json:"id"`
	} `json:"station"`
	Timestamp          string              `json:"timestamp"`
	Confidence         *float64            `json:"confidence"`
	Probability        *float64            `json:"probability"`
	Score              *float64            `json:"score"`
	Certainty          *string             `json:"certainty"`
	Algorithm          *string             `json:"algorithm"`
	Species            *upstreamSpecies    `json:"species"`
	Soundscape         *upstreamSoundscape `json:"soundscape"`
	Behavior           *string             `json:"behavior"`
	BehaviorCode       *string             `json:"behaviorCode"`
	BehaviorKey        *string             `json:"behaviorKey"`
	BehaviorKeyLegacy  *string             `json:"behavior_key"`
	BehaviorConfidence *float64            `json:"behaviorConfidence"`
	ConfidenceLegacy   *float64            `json:"behavior_confidence"`
	Shortlist          []struct {
		SpeciesID      identifier       `json:"speciesId"`
		CommonName     string           `json:"commonName"`
		ScientificName string           `json:"scientificName"`
		Weight         *float64         `json:"weight"`
		Species        *upstreamSpecies `json:"species"`
	} `json:"shortlist"`
}

func normalizeRecording(raw json.RawMessage, stationID string) (Recording, error) {
	var upstream upstreamDetection
	if err := json.Unmarshal(raw, &upstream); err != nil {
		return Recording{}, fmt.Errorf("%w: detection", ErrUpstream)
	}
	owner := string(upstream.StationID)
	if upstream.Station != nil {
		if owner != "" && owner != string(upstream.Station.ID) {
			return Recording{}, ErrWrongStation
		}
		owner = string(upstream.Station.ID)
	}
	if owner != stationID {
		return Recording{}, ErrWrongStation
	}
	if !validID(string(upstream.ID)) || upstream.Species == nil || !validID(string(upstream.Species.ID)) || cleanText(upstream.Species.CommonName, 240) == "" || !unitFloat(upstream.Confidence) {
		return Recording{}, fmt.Errorf("%w: required detection fields", ErrUpstream)
	}
	if _, err := time.Parse(time.RFC3339Nano, upstream.Timestamp); err != nil {
		return Recording{}, fmt.Errorf("%w: detection timestamp", ErrUpstream)
	}
	classification := "other"
	if upstream.Species.Classification == "avian" {
		classification = "bird"
	} else if upstream.Species.Classification == "bat" {
		classification = "bat"
	}
	recording := Recording{
		ID: string(upstream.ID), Timestamp: upstream.Timestamp, CommonName: cleanText(upstream.Species.CommonName, 240),
		ScientificName: cleanText(upstream.Species.ScientificName, 240), SpeciesID: string(upstream.Species.ID),
		Classification: classification, Confidence: *upstream.Confidence, Probability: nonnegative(upstream.Probability),
		Score: nonnegative(upstream.Score), Certainty: optionalText(upstream.Certainty, 100), Algorithm: optionalText(upstream.Algorithm, 100),
		Behavior: optionalText(upstream.Behavior, 240), Shortlist: []Candidate{}, Raw: append(json.RawMessage(nil), raw...),
	}
	if !unitFloat(recording.Probability) {
		recording.Probability = nil
	}
	recording.BehaviorCode = optionalText(firstString(upstream.BehaviorCode, upstream.BehaviorKey, upstream.BehaviorKeyLegacy), 100)
	recording.BehaviorConfidence = upstream.BehaviorConfidence
	if recording.BehaviorConfidence == nil {
		recording.BehaviorConfidence = upstream.ConfidenceLegacy
	}
	if !unitFloat(recording.BehaviorConfidence) {
		recording.BehaviorConfidence = nil
	}
	setPhoto(&recording, *upstream.Species)
	if soundscape := upstream.Soundscape; soundscape != nil {
		if soundscape.StationID != "" && string(soundscape.StationID) != stationID || soundscape.Station != nil && string(soundscape.Station.ID) != stationID {
			return Recording{}, ErrWrongStation
		}
		recording.AudioURL = mediaURL(soundscape.URL, "soundscapes")
		if recording.AudioURL != nil {
			parsed, _ := url.Parse(*recording.AudioURL)
			if !strings.HasPrefix(parsed.Path, "/soundscapes/"+stationID+"/") {
				recording.AudioURL = nil
			}
		}
		if soundscape.ID != "" {
			id := string(soundscape.ID)
			recording.SoundscapeID = &id
		}
		recording.Duration = nonnegative(soundscape.Duration)
		if soundscape.SampleRate != nil && *soundscape.SampleRate > 0 && *soundscape.SampleRate <= 2000000 {
			recording.SampleRate = soundscape.SampleRate
		}
		start, end := nonnegative(soundscape.StartTime), nonnegative(soundscape.EndTime)
		if recording.AudioURL != nil && start != nil && end != nil && *end > *start && (recording.Duration == nil || *end <= *recording.Duration+.001) {
			recording.StartTime, recording.EndTime = start, end
		}
	}
	if len(upstream.Shortlist) > 100 {
		return Recording{}, fmt.Errorf("%w: shortlist size", ErrUpstream)
	}
	for _, item := range upstream.Shortlist {
		if !validID(string(item.SpeciesID)) || !unitFloat(item.Weight) {
			return Recording{}, fmt.Errorf("%w: shortlist candidate", ErrUpstream)
		}
		common, scientific := item.CommonName, item.ScientificName
		if item.Species != nil {
			if item.Species.ID != item.SpeciesID {
				return Recording{}, fmt.Errorf("%w: shortlist species", ErrUpstream)
			}
			common, scientific = item.Species.CommonName, item.Species.ScientificName
		}
		recording.Shortlist = append(recording.Shortlist, Candidate{SpeciesID: string(item.SpeciesID), CommonName: cleanText(common, 240), ScientificName: cleanText(scientific, 240), Weight: *item.Weight})
	}
	return recording, nil
}

func cleanText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) > limit || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return ""
	}
	return value
}

func optionalText(value *string, limit int) *string {
	if value == nil {
		return nil
	}
	text := cleanText(*value, limit)
	if text == "" {
		return nil
	}
	return &text
}

func firstString(values ...*string) *string {
	for _, value := range values {
		if value != nil && *value != "" {
			return value
		}
	}
	return nil
}

func unitFloat(value *float64) bool {
	return value != nil && !math.IsNaN(*value) && !math.IsInf(*value, 0) && *value >= 0 && *value <= 1
}

func nonnegative(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 {
		return nil
	}
	return value
}

func safeLink(value *string) *string {
	value = optionalText(value, 2048)
	if value == nil {
		return nil
	}
	raw := *value
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.Hostname() == "" || parsed.Opaque != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil
	}
	if parsed.Hostname() == "creativecommons.org" || strings.HasSuffix(parsed.Hostname(), ".wikimedia.org") {
		parsed.Scheme = "https"
	}
	result := parsed.String()
	return &result
}

func mediaURL(value *string, directory string) *string {
	link := safeLink(value)
	if link == nil {
		return nil
	}
	parsed, _ := url.Parse(*link)
	if parsed.Scheme != "https" || parsed.Host != "media.birdweather.com" || !strings.HasPrefix(parsed.Path, "/"+directory+"/") || parsed.RawQuery != "" || parsed.Fragment != "" || strings.Contains(parsed.Path, "/../") {
		return nil
	}
	return link
}

func credit(value *string) (*string, *string) {
	value = optionalText(value, 4096)
	if value == nil {
		return nil, nil
	}
	if !strings.Contains(*value, "<") {
		plain := html.UnescapeString(*value)
		return optionalText(&plain, 500), nil
	}
	decoder := xml.NewDecoder(strings.NewReader("<credit>" + *value + "</credit>"))
	decoder.Strict = false
	decoder.AutoClose = xml.HTMLAutoClose
	decoder.Entity = xml.HTMLEntity
	var text strings.Builder
	var source *string
	skip := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil
		}
		switch token := token.(type) {
		case xml.StartElement:
			name := strings.ToLower(token.Name.Local)
			if skip > 0 || contains([]string{"script", "style", "iframe", "object", "template"}, name) {
				skip++
				continue
			}
			if name == "a" && source == nil {
				for _, attribute := range token.Attr {
					if strings.EqualFold(attribute.Name.Local, "href") {
						source = safeLink(&attribute.Value)
					}
				}
			}
		case xml.EndElement:
			if skip > 0 {
				skip--
			}
		case xml.CharData:
			if skip == 0 {
				text.Write(token)
			}
		}
	}
	plain := strings.Join(strings.Fields(text.String()), " ")
	return optionalText(&plain, 500), source
}

func setPhoto(recording *Recording, species upstreamSpecies) {
	recording.ImageCredit, recording.ImageSource = credit(firstString(species.ImageCreditHTML, species.ImageCredit))
	if explicit := safeLink(species.ImageCreditURL); explicit != nil {
		recording.ImageSource = explicit
	}
	recording.ImageLicense = optionalText(species.ImageLicense, 240)
	recording.ImageLicenseURL = safeLink(species.ImageLicenseURL)
	recording.ImageURL = nil
	if recording.ImageCredit != nil && recording.ImageLicense != nil {
		recording.ImageURL = mediaURL(species.ImageURL, "species")
	}
}

func (c *Client) station(ctx context.Context) (Station, Response, error) {
	response, err := c.GraphQL(ctx, "station", nil)
	if err != nil {
		return Station{}, Response{}, err
	}
	raw, err := rawField(response.Body, "data", "station")
	if err != nil {
		return Station{}, Response{}, err
	}
	var station Station
	if json.Unmarshal(raw, &station) != nil || station.ID != c.stationID || cleanText(station.Name, 240) == "" {
		return Station{}, Response{}, fmt.Errorf("%w: station metadata", ErrUpstream)
	}
	if _, err := time.LoadLocation(station.Timezone); err != nil {
		return Station{}, Response{}, fmt.Errorf("%w: station timezone", ErrUpstream)
	}
	return station, response, nil
}

func (c *Client) Feed(ctx context.Context, params url.Values) (Response, error) {
	query := cloneValues(params)
	if values, ok := query["cursor"]; ok {
		if _, exists := query["after"]; exists {
			return Response{}, fmt.Errorf("%w: duplicate pagination", ErrInvalidRequest)
		}
		query["after"] = values
		delete(query, "cursor")
	}
	if values, ok := query["classification"]; ok {
		if len(values) != 1 || !contains([]string{"all", "bird", "bat"}, values[0]) || query.Get("classifications") != "" {
			return Response{}, fmt.Errorf("%w: classification", ErrInvalidRequest)
		}
		switch values[0] {
		case "bird":
			query.Set("classifications", "avian")
		case "bat":
			query.Set("classifications", "bat")
		}
		delete(query, "classification")
	}
	response, err := c.GraphQL(ctx, "detections", query)
	if err != nil {
		return Response{}, err
	}
	raw, err := rawField(response.Body, "data", "detections")
	if err != nil {
		return Response{}, err
	}
	var connection struct {
		Nodes    []json.RawMessage `json:"nodes"`
		PageInfo struct {
			HasNextPage bool    `json:"hasNextPage"`
			EndCursor   *string `json:"endCursor"`
		} `json:"pageInfo"`
	}
	if json.Unmarshal(raw, &connection) != nil || connection.Nodes == nil || len(connection.Nodes) > 100 {
		return Response{}, fmt.Errorf("%w: detection connection", ErrUpstream)
	}
	recordings := make([]Recording, 0, len(connection.Nodes))
	seen := map[string]bool{}
	for _, node := range connection.Nodes {
		if bytes.Equal(bytes.TrimSpace(node), []byte("null")) {
			continue
		}
		recording, err := normalizeRecording(node, c.stationID)
		if err != nil {
			return Response{}, err
		}
		if seen[recording.ID] {
			return Response{}, fmt.Errorf("%w: duplicate recording", ErrUpstream)
		}
		seen[recording.ID] = true
		recordings = append(recordings, recording)
	}
	var cursor *string
	if connection.PageInfo.HasNextPage {
		cursor = optionalText(connection.PageInfo.EndCursor, 512)
		if cursor == nil || len(connection.Nodes) == 0 || *cursor == query.Get("after") {
			return Response{}, fmt.Errorf("%w: pagination cursor", ErrUpstream)
		}
	}
	station, metadata, err := c.station(ctx)
	if err != nil {
		return Response{}, err
	}
	var missingPhotos []string
	for _, recording := range recordings {
		if recording.ImageURL == nil {
			missingPhotos = append(missingPhotos, recording.SpeciesID)
		}
	}
	photos, photoResponses := c.photoMetadata(ctx, missingPhotos)
	for i := range recordings {
		if species, exists := photos[recordings[i].SpeciesID]; exists {
			setPhoto(&recordings[i], species)
		}
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	parts := append([]Response{response, metadata}, photoResponses...)
	stale := false
	for _, part := range parts {
		stale = stale || part.Stale
	}
	feed := Feed{Station: station, Recordings: recordings, NextCursor: cursor, FetchedAt: response.FetchedAt, Stale: stale}
	return encodeResponse(feed, parts...)
}

func (c *Client) Recording(ctx context.Context, id string) (Response, error) {
	response, err := c.REST(ctx, "detections", id, nil)
	if err != nil {
		return Response{}, err
	}
	raw, err := rawField(response.Body, "detection")
	if err != nil {
		return Response{}, err
	}
	recording, err := normalizeRecording(raw, c.stationID)
	if err != nil {
		return Response{}, err
	}
	type enrichment struct {
		kind     string
		response Response
		photo    *upstreamSpecies
		parts    []Response
		err      error
	}
	results := make(chan enrichment, 2)
	count := 0
	if recording.ImageURL == nil {
		count++
		go func() {
			photos, parts := c.photoMetadata(ctx, []string{recording.SpeciesID})
			result := enrichment{kind: "species", parts: parts}
			if photo, exists := photos[recording.SpeciesID]; exists {
				result.photo = &photo
			}
			results <- result
		}()
	}
	if recording.SoundscapeID != nil {
		count++
		go func(soundscapeID string) {
			result, err := c.REST(ctx, "soundscapes", soundscapeID, nil)
			results <- enrichment{kind: "soundscape", response: result, err: err}
		}(*recording.SoundscapeID)
	}
	parts := []Response{response}
	for range count {
		result := <-results
		if result.kind == "species" {
			parts = append(parts, result.parts...)
			if result.photo != nil {
				setPhoto(&recording, *result.photo)
			}
			continue
		}
		if result.err != nil {
			continue
		}
		parts = append(parts, result.response)
		data, err := rawField(result.response.Body, "soundscape")
		var soundscape upstreamSoundscape
		if err == nil && json.Unmarshal(data, &soundscape) == nil {
			recording.Duration = nonnegative(soundscape.Duration)
			if soundscape.SampleRate != nil && *soundscape.SampleRate > 0 && *soundscape.SampleRate <= 2000000 {
				recording.SampleRate = soundscape.SampleRate
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	return encodeResponse(recording, parts...)
}

func normalizeSpeciesPhotos(raw json.RawMessage) (json.RawMessage, error) {
	var rankings []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rankings); err != nil {
		return nil, fmt.Errorf("%w: species ranking", ErrUpstream)
	}
	for _, ranking := range rankings {
		if bytes.Equal(ranking["species"], []byte("null")) {
			continue
		}
		var species upstreamSpecies
		var data map[string]json.RawMessage
		if json.Unmarshal(ranking["species"], &species) != nil || json.Unmarshal(ranking["species"], &data) != nil || data == nil {
			return nil, fmt.Errorf("%w: species metadata", ErrUpstream)
		}
		var record Recording
		setPhoto(&record, species)
		for key, value := range map[string]*string{"imageUrl": record.ImageURL, "imageCredit": record.ImageCredit, "imageLicense": record.ImageLicense, "imageLicenseUrl": record.ImageLicenseURL, "imageSource": record.ImageSource} {
			data[key], _ = json.Marshal(value)
		}
		ranking["species"], _ = json.Marshal(data)
	}
	return json.Marshal(rankings)
}

func (c *Client) photoMetadata(ctx context.Context, ids []string) (map[string]upstreamSpecies, []Response) {
	type result struct {
		id      string
		species upstreamSpecies
		parts   []Response
		ok      bool
	}
	unique := map[string]bool{}
	for _, id := range ids {
		unique[id] = true
	}
	jobs := make(chan string, len(unique))
	results := make(chan result, len(unique))
	for id := range unique {
		jobs <- id
	}
	close(jobs)
	for range min(4, len(unique)) {
		go func() {
			for id := range jobs {
				response, err := c.REST(ctx, "species", id, nil)
				item := result{id: id}
				if err == nil {
					item.parts = append(item.parts, response)
					raw, err := rawField(response.Body, "species")
					item.ok = err == nil && json.Unmarshal(raw, &item.species) == nil
				}
				var photo Recording
				setPhoto(&photo, item.species)
				// Supplement older REST attribution without replacing its immutable snapshot.
				if photo.ImageURL == nil && ctx.Err() == nil {
					response, err := c.GraphQL(ctx, "species-details", url.Values{"speciesId": {id}})
					if err == nil {
						var candidate upstreamSpecies
						raw, err := rawField(response.Body, "data", "species")
						if err == nil && json.Unmarshal(raw, &candidate) == nil {
							setPhoto(&photo, candidate)
							if photo.ImageURL != nil || !item.ok {
								item.species, item.ok = candidate, true
							}
							item.parts = append(item.parts, response)
						}
					}
				}
				results <- item
			}
		}()
	}
	photos := make(map[string]upstreamSpecies, len(unique))
	var responses []Response
	for range len(unique) {
		item := <-results
		if item.ok {
			photos[item.id] = item.species
			responses = append(responses, item.parts...)
		}
	}
	return photos, responses
}

func (c *Client) enrichRankingPhotos(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	normalized, err := normalizeSpeciesPhotos(raw)
	if err != nil {
		return nil, err
	}
	var rankings []map[string]json.RawMessage
	_ = json.Unmarshal(normalized, &rankings)
	var ids []string
	for _, ranking := range rankings {
		var species upstreamSpecies
		if json.Unmarshal(ranking["species"], &species) == nil && species.ID != "" && species.ImageURL == nil {
			ids = append(ids, string(species.ID))
		}
	}
	photos, _ := c.photoMetadata(ctx, ids)
	for _, ranking := range rankings {
		var species upstreamSpecies
		if json.Unmarshal(ranking["species"], &species) != nil {
			continue
		}
		if metadata, exists := photos[string(species.ID)]; exists {
			var data map[string]json.RawMessage
			_ = json.Unmarshal(ranking["species"], &data)
			var record Recording
			setPhoto(&record, metadata)
			for key, value := range map[string]*string{"imageUrl": record.ImageURL, "imageCredit": record.ImageCredit, "imageLicense": record.ImageLicense, "imageLicenseUrl": record.ImageLicenseURL, "imageSource": record.ImageSource} {
				data[key], _ = json.Marshal(value)
			}
			ranking["species"], _ = json.Marshal(data)
		}
	}
	return json.Marshal(rankings)
}

func (c *Client) SpeciesRanking(ctx context.Context, params url.Values) (Response, error) {
	response, err := c.GraphQL(ctx, "species", params)
	if err != nil {
		return Response{}, err
	}
	raw, err := rawField(response.Body, "data", "topSpecies")
	if err != nil {
		return Response{}, err
	}
	raw, err = c.enrichRankingPhotos(ctx, raw)
	if err != nil {
		return Response{}, err
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	return encodeResponse(json.RawMessage(raw), response)
}
