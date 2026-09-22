package birdweather

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const speciesFields = `id commonName scientificName classification color imageUrl thumbnailUrl thumbhash imageCredit imageLicense imageLicenseUrl`
const speciesReferenceFields = speciesFields + ` alpha alpha6 ebirdCode ebirdUrl mlUrl birdweatherUrl wikipediaUrl wikipediaSummary rangeUrl translations { locale commonName wikipediaSummary wikipediaUrl }`
const stationFields = `id name type edition timezone notes continent country state location coords { lat lon } locationPrivacy locationPrivacyRadius portableDetections earliestDetectionAt latestDetectionAt minConfidence minProbability minScore hasProbabilities openWeather audioUrl videoUrl eclipse`
const soundscapeFields = `id url timestamp downloadFilename duration filesize sampleRate mode startTime endTime station { id }`
const detectionFields = `id timestamp confidence probability score certainty mode behavior behaviorCode behaviorConfidence eclipse speciesId station { id } species { ` + speciesFields + ` } shortlist { speciesId weight species { id commonName scientificName } } soundscape { ` + soundscapeFields + ` }`
const connectionFields = `pageInfo { hasNextPage hasPreviousPage startCursor endCursor } nodes { ` + detectionFields + ` }`
const rankingFields = `speciesId count averageProbability breakdown { almostCertain veryLikely uncertain unlikely } species { ` + speciesFields + ` }`
const binnedFields = `speciesId count bins { key count } species { id commonName scientificName classification color }`
const weatherFields = `weather { timestamp description temp tempMin tempMax feelsLike humidity pressure seaLevel groundLevel windSpeed windDir windGust cloudiness visibility rain1h rain3h snow1h snow3h sunrise sunset } airPollution { timestamp aqi co no no2 o3 so2 pm2_5 pm10 nh3 }`

var sensorFields = map[string]string{
	"environment": `timestamp temperature humidity barometricPressure voc aqi eco2 soundPressureLevel`,
	"system":      `timestamp powerSource batteryVoltage usbVoltage sdCapacity sdAvailable wifiRssi uploadingCompleted uploadingTotal`,
	"accel":       `timestamp x y z`,
	"mag":         `timestamp x y z`,
	"light":       `timestamp clear f1 f2 f3 f4 f5 f6 f7 f8 nir`,
	"location":    `timestamp lat lon altitude satellites`,
	"detections":  `timestamp detections species`,
}

type graphqlOperation struct {
	name        string
	label       string
	description string
	params      rules
}

func graphqlOperations() []graphqlOperation {
	filters := mergeRules(periodRules, thresholdRules, rules{
		"speciesId": {kind: "id"}, "speciesIds": {kind: "ids", maxLen: 1100},
		"classifications": list(classifications...), "recordingModes": list(recordingModes...),
		"behaviors": list(behaviors...), "vote": integer(-1, 1), "sortBy": {kind: "identifier"},
		"validSoundscape": {kind: "bool"}, "overrideStationFilters": {kind: "bool"},
	})
	chart := mergeRules(periodRules, thresholdRules, rules{"speciesId": {kind: "id"}})
	result := []graphqlOperation{
		{"station", "Station information", "Configured station metadata, privacy settings, thresholds and optional stream links.", rules{}},
		{"counts", "Detection and species counts", "Upstream station-filtered counts. Count definitions can differ from feed connection totals.", mergeRules(periodRules, rules{"speciesId": {kind: "id"}, "classifications": list(classifications...)})},
		{"species", "Species ranking", "Species detected by this station with certainty breakdowns.", mergeRules(periodRules, rules{"speciesId": {kind: "id"}, "classifications": list(classifications...), "recordingModes": list(recordingModes...), "limit": integer(1, 100), "offset": integer(0, 100000)})},
		{"detections", "Detection feed", "Station-confined detections with bat behavior, alternatives and soundscapes.", mergeRules(filters, pageRules)},
		{"detection-counts", "Detection histogram", "Upstream bins for the configured station.", chart},
		{"daily-counts", "Daily species counts", "Daily totals and species counts for this station.", mergeRules(periodRules, rules{"speciesIds": {kind: "ids", maxLen: 1100}})},
		{"time-of-day", "Time-of-day activity", "Upstream activity bins; numeric keys are fractional hours.", chart},
		{"weather", "OpenWeather conditions", "Optional weather and pollution readings, distinct from PUC sensors.", rules{}},
		{"sensors", "Latest PUC sensors", "Environment, power, light, motion and location readings when available.", rules{"sensorType": {kind: "identifier"}, "fieldName": {kind: "identifier"}}},
		{"probabilities", "Station species probabilities", "Monthly and weekly reference probabilities for the station location.", rules{}},
		{"species-details", "Species metadata", "Reference metadata for an eligible station species, including attribution and range-file links.", rules{"speciesId": {kind: "id", required: true}}},
		{"species-range", "Species geographic reference", "Range and prediction-area reference data for an eligible station species.", rules{"speciesId": {kind: "id", required: true}}},
		{"species-counts", "Species detection bins", "Species histogram with stationIds fixed to the configured station.", mergeRules(periodRules, rules{"speciesId": {kind: "id", required: true}, "group": integer(1, 366)})},
		{"species-probabilities", "Species probability models", "Model probabilities bounded to the configured station coordinates.", rules{"speciesId": {kind: "id", required: true}, "model": {kind: "enum", required: true, options: []string{"BIRDNET", "FOGLEMAN", "INATURALIST", "BIRDWEATHER"}}}},
		{"species-lookup", "Species metadata batch", "At most 50 eligible species IDs; no global taxonomy crawl.", rules{"ids": {kind: "ids", maxLen: 1100, required: true}}},
		{"species-search", "Search station species", "Searches this station's REST species collection rather than global species.", mergeRules(rules{"query": textRule(240), "locale": textRule(20), "classification": list(classifications...), "limit": integer(1, 100), "page": integer(1, 100000), "period": enum("day", "week", "month", "all")})},
	}
	for _, name := range []string{"environment", "system", "accel", "mag", "light", "location", "detections"} {
		description := "Paged " + name + " readings for this station."
		if name == "detections" {
			description += " Upstream returned HTTP 500 during verification; failure does not affect other sections."
		}
		result = append(result, graphqlOperation{name + "-history", name + " history", description, mergeRules(pageRules, periodRules)})
	}
	return result
}

type queryBuilder struct {
	variables map[string]any
	types     map[string]string
}

func (b *queryBuilder) variable(name, graphqlType string, value any) string {
	b.variables[name], b.types[name] = value, graphqlType
	return "$" + name
}

func (b *queryBuilder) arguments(params url.Values, allowed rules) string {
	keys := make([]string, 0, len(params))
	for key := range params {
		if key != "period" && key != "count" && key != "unit" && key != "from" && key != "to" && key != "timezone" && key != "ids" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	arguments := make([]string, 0, len(keys))
	for _, key := range keys {
		value := params.Get(key)
		var converted any = value
		graphqlType := "String"
		switch allowed[key].kind {
		case "id":
			graphqlType = "ID"
		case "ids":
			graphqlType, converted = "[ID!]", strings.Split(value, ",")
		case "list":
			graphqlType, converted = "[String!]", strings.Split(value, ",")
		case "int":
			graphqlType = "Int"
			converted, _ = strconv.Atoi(value)
		case "float":
			graphqlType = "Float"
			converted, _ = strconv.ParseFloat(value, 64)
		case "bool":
			graphqlType, converted = "Boolean", value == "true"
		}
		if key == "model" {
			graphqlType = "ProbabilityModel!"
		}
		arguments = append(arguments, key+":"+b.variable(key, graphqlType, converted))
	}
	return strings.Join(arguments, ",")
}

func arguments(parts ...string) string {
	var nonempty []string
	for _, part := range parts {
		if part != "" {
			nonempty = append(nonempty, part)
		}
	}
	if len(nonempty) == 0 {
		return ""
	}
	return "(" + strings.Join(nonempty, ",") + ")"
}

func (c *Client) GraphQL(ctx context.Context, operation string, params url.Values) (Response, error) {
	var spec *graphqlOperation
	for _, candidate := range graphqlOperations() {
		if candidate.name == operation {
			copy := candidate
			spec = &copy
			break
		}
	}
	if spec == nil {
		return Response{}, fmt.Errorf("%w: unsupported GraphQL operation", ErrInvalidRequest)
	}
	query, err := validateParams(params, spec.params)
	if err != nil {
		return Response{}, err
	}
	if operation == "species-search" {
		response, err := c.REST(ctx, "species", "", query)
		if err != nil {
			return Response{}, err
		}
		species, err := rawField(response.Body, "species")
		if err != nil {
			return Response{}, err
		}
		return encodeResponse(map[string]any{"data": map[string]any{"searchSpecies": map[string]any{"nodes": species}}}, response)
	}
	if _, err := periodInput(query); err != nil {
		return Response{}, err
	}
	if query.Get("period") == "all" {
		station, _, err := c.station(ctx)
		if err != nil {
			return Response{}, err
		}
		location, _ := time.LoadLocation(station.Timezone)
		now := time.Now().In(location)
		start := now
		if station.EarliestDetectionAt != nil {
			start, err = time.Parse(time.RFC3339Nano, *station.EarliestDetectionAt)
			if err != nil || start.After(now) {
				return Response{}, fmt.Errorf("%w: earliest detection timestamp", ErrUpstream)
			}
		}
		query.Del("period")
		query.Set("from", start.In(location).Format(time.DateOnly))
		query.Set("to", now.Format(time.DateOnly))
		query.Set("timezone", station.Timezone)
	}
	if (query.Get("from") != "" || query.Get("to") != "") && query.Get("timezone") == "" {
		station, _, err := c.station(ctx)
		if err != nil {
			return Response{}, err
		}
		query.Set("timezone", station.Timezone)
	}
	period, err := periodInput(query)
	if err != nil {
		return Response{}, err
	}
	if _, paginated := spec.params["first"]; paginated && query.Get("first") == "" && query.Get("last") == "" {
		if query.Get("before") != "" {
			query.Set("last", "36")
		} else {
			query.Set("first", "36")
		}
	}
	if _, ranked := spec.params["limit"]; ranked && query.Get("limit") == "" {
		query.Set("limit", "36")
	}
	builder := &queryBuilder{variables: map[string]any{}, types: map[string]string{}}
	args := builder.arguments(query, spec.params)
	if period != nil {
		args = strings.Trim(args+",period:"+builder.variable("period", "InputDuration", period), ",")
	}
	stationRoot := func(fields string) string {
		return "station(id:" + builder.variable("stationID", "ID!", c.stationID) + "){id " + fields + "}"
	}
	stationIDs := func() string {
		return "stationIds:" + builder.variable("stationIDs", "[ID!]", []string{c.stationID})
	}
	var selection string
	immutable := historical(query)
	freshness := dynamicFreshness
	switch operation {
	case "station":
		selection = stationRoot(stationFields)
		freshness = metadataFreshness
	case "counts":
		selection = "counts" + arguments(stationIDs(), args) + `{detections species stations breakdown { stations { type count } }}`
	case "species":
		selection = "topSpecies" + arguments(stationIDs(), args) + "{" + rankingFields + "}"
	case "detections":
		selection = "detections" + arguments(stationIDs(), args) + "{" + connectionFields + "}"
	case "detection-counts":
		selection = stationRoot("detectionCounts" + arguments(args) + "{" + binnedFields + "}")
	case "daily-counts":
		selection = "dailyDetectionCounts" + arguments(stationIDs(), args) + `{date dayOfYear total counts { speciesId count species { id commonName scientificName classification color } }}`
	case "time-of-day":
		selection = "timeOfDayDetectionCounts" + arguments(stationIDs(), args) + "{" + binnedFields + "}"
	case "weather":
		selection = stationRoot(weatherFields)
	case "sensors":
		var fields []string
		for _, sensor := range []string{"environment", "system", "accel", "mag", "light", "location"} {
			fields = append(fields, sensor+"{"+sensorFields[sensor]+"}")
		}
		selection = stationRoot("sensors" + arguments(args) + "{" + strings.Join(fields, " ") + "}")
	case "probabilities":
		selection = stationRoot(`probabilities { speciesId months weeks species { id commonName scientificName classification } }`)
		freshness = metadataFreshness
	case "species-details", "species-range":
		fields := speciesReferenceFields
		if operation == "species-range" {
			fields = "id range rangeUrl predictionArea"
		}
		selection = "species(id:$speciesId){" + fields + "}"
		immutable = true
	case "species-counts":
		delete(builder.types, "speciesId")
		delete(builder.variables, "speciesId")
		args = removeArgument(args, "speciesId")
		// The nested species resolver returns null despite its non-null schema; the parent already supplies identity.
		selection = "species(id:" + builder.variable("speciesID", "ID!", query.Get("speciesId")) + "){id detectionCounts" + arguments(stationIDs(), args) + "{speciesId count bins { key count }}}"
	case "species-probabilities":
		metadata, err := c.GraphQL(ctx, "station", nil)
		if err != nil {
			return Response{}, err
		}
		raw, err := rawField(metadata.Body, "data", "station", "coords")
		if err != nil {
			return Response{}, err
		}
		var coordinates map[string]float64
		if json.Unmarshal(raw, &coordinates) != nil || coordinates == nil {
			return Response{}, fmt.Errorf("%w: station coordinates unavailable", ErrUpstream)
		}
		lat, latOK := coordinates["lat"]
		lon, lonOK := coordinates["lon"]
		if !latOK || !lonOK || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			return Response{}, fmt.Errorf("%w: station coordinates", ErrUpstream)
		}
		builder.variable("location", "InputLocation", coordinates)
		// SpeciesProbabilities.speciesId is also broken upstream; retain the enclosing species ID instead.
		selection = `species(id:$speciesId){id probabilities(model:$model,ne:$location,sw:$location){precision locations{coords{lat lon} probabilities}}}`
		freshness = metadataFreshness
	case "species-lookup":
		ids := strings.Split(query.Get("ids"), ",")
		selection = "allSpecies(ids:" + builder.variable("ids", "[ID!]!", ids) + ",first:" + builder.variable("batchSize", "Int", len(ids)) + "){nodes{" + speciesReferenceFields + "}}"
		immutable = true
	default:
		name := strings.TrimSuffix(operation, "-history")
		fields, ok := sensorFields[name]
		if !ok || name == operation {
			return Response{}, fmt.Errorf("%w: unsupported GraphQL operation", ErrInvalidRequest)
		}
		selection = stationRoot("sensors{" + name + "History" + arguments(args) + "{pageInfo{hasNextPage hasPreviousPage startCursor endCursor} nodes{" + fields + "}}}")
	}
	names := make([]string, 0, len(builder.types))
	for name := range builder.types {
		names = append(names, name)
	}
	sort.Strings(names)
	definitions := make([]string, 0, len(names))
	for _, name := range names {
		definitions = append(definitions, "$"+name+":"+builder.types[name])
	}
	document := "query FARTSRead"
	if len(definitions) > 0 {
		document += "(" + strings.Join(definitions, ",") + ")"
	}
	document += "{" + selection + "}"
	body, err := json.Marshal(map[string]any{"query": document, "variables": builder.variables})
	if err != nil {
		return Response{}, fmt.Errorf("%w: query encoding", ErrInvalidRequest)
	}
	response, err := c.do(ctx, Request{Operation: "graphql:" + operation, Method: http.MethodPost, Path: "/graphql", Body: body, FreshFor: freshness, Immutable: immutable}, true)
	if err != nil {
		return Response{}, err
	}
	if strings.HasPrefix(operation, "species-") && operation != "species-lookup" {
		raw, err := rawField(response.Body, "data", "species")
		if err != nil {
			return Response{}, err
		}
		var species struct {
			ID identifier `json:"id"`
		}
		if json.Unmarshal(raw, &species) != nil || string(species.ID) != query.Get("speciesId") {
			return Response{}, fmt.Errorf("%w: species identifier", ErrUpstream)
		}
	}
	return response, nil
}

func removeArgument(arguments, name string) string {
	var kept []string
	for _, argument := range strings.Split(arguments, ",") {
		if !strings.HasPrefix(argument, name+":") {
			kept = append(kept, argument)
		}
	}
	return strings.Join(kept, ",")
}

func Capabilities() CapabilityList {
	result := CapabilityList{Operations: []Capability{}}
	for _, spec := range restOperations() {
		path := "/api/birdweather/" + spec.resource
		id := "rest:" + spec.resource
		params := parameters(spec.params)
		if spec.detail {
			path += "/:id"
			id += ":detail"
			params = append([]Parameter{{Name: "id", Type: "string", Required: true}}, params...)
		}
		result.Operations = append(result.Operations, Capability{ID: id, Label: spec.label, Description: spec.label + " for the configured station and its eligible species.", Path: path, Method: http.MethodGet, Parameters: params})
	}
	for _, spec := range graphqlOperations() {
		result.Operations = append(result.Operations, Capability{ID: "graphql:" + spec.name, Label: spec.label, Description: spec.description, Path: "/api/graphql/" + spec.name, Method: http.MethodGet, Parameters: parameters(spec.params)})
	}
	return result
}
