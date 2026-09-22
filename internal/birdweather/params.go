package birdweather

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type rule struct {
	kind     string
	options  []string
	min      float64
	max      float64
	maxLen   int
	required bool
	def      string
}

type rules map[string]rule

var idPattern = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
var identifierPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_:-]{0,63}$`)

func validID(id string) bool { return idPattern.MatchString(id) }

func enum(options ...string) rule { return rule{kind: "enum", options: options, maxLen: 64} }
func integer(min, max int) rule   { return rule{kind: "int", min: float64(min), max: float64(max)} }
func textRule(max int) rule       { return rule{kind: "text", maxLen: max} }
func list(options ...string) rule { return rule{kind: "list", options: options, maxLen: 2048} }

func mergeRules(groups ...rules) rules {
	merged := make(rules)
	for _, group := range groups {
		for key, value := range group {
			merged[key] = value
		}
	}
	return merged
}

var (
	classifications = []string{"avian", "amphibian", "reptile", "mammal", "bat", "insect"}
	recordingModes  = []string{"live", "recorded", "birdnetpi"}
	behaviors       = []string{"bat_search_open", "bat_search_clutter", "bat_chase", "bat_feeding_buzz", "bat_approach", "bat_pass"}
	pageRules       = rules{"first": integer(1, 100), "last": integer(1, 100), "after": textRule(512), "before": textRule(512)}
	periodRules     = rules{
		"period": enum("day", "week", "month", "year", "all"), "count": integer(1, 3660),
		"unit": enum("hour", "day", "week", "month", "year"),
		"from": {kind: "date"}, "to": {kind: "date"}, "timezone": {kind: "timezone", maxLen: 100},
	}
	thresholdRules = rules{
		"timeOfDayGte": integer(0, 86400), "timeOfDayLte": integer(0, 86400),
	}
)

func init() {
	for _, prefix := range []string{"score", "confidence", "probability"} {
		max := 1.0
		if prefix == "score" {
			max = 100
		}
		for _, suffix := range []string{"Gt", "Lt", "Gte", "Lte"} {
			thresholdRules[prefix+suffix] = rule{kind: "float", min: 0, max: max}
		}
	}
}

func validateParams(params url.Values, allowed rules) (url.Values, error) {
	if len(params) > 48 {
		return nil, fmt.Errorf("%w: too many parameters", ErrInvalidRequest)
	}
	validated := make(url.Values)
	for key, values := range params {
		spec, exists := allowed[key]
		if !exists || len(values) != 1 {
			return nil, fmt.Errorf("%w: unsupported or repeated parameter %q", ErrInvalidRequest, safeParameterName(key))
		}
		value := values[0]
		if len(value) > 4096 || value == "" || strings.TrimSpace(value) != value || strings.IndexFunc(value, unicode.IsControl) >= 0 {
			return nil, fmt.Errorf("%w: parameter %q", ErrInvalidRequest, key)
		}
		if spec.maxLen > 0 && len(value) > spec.maxLen {
			return nil, fmt.Errorf("%w: parameter %q is too long", ErrInvalidRequest, key)
		}
		valid := true
		switch spec.kind {
		case "id":
			valid = validID(value)
		case "ids", "list":
			items := strings.Split(value, ",")
			valid = len(items) <= 50
			seen := map[string]bool{}
			for _, item := range items {
				if item == "" || strings.TrimSpace(item) != item || seen[item] || (spec.kind == "ids" && !validID(item)) || (len(spec.options) > 0 && !contains(spec.options, item)) {
					valid = false
				}
				seen[item] = true
			}
		case "int":
			n, err := strconv.ParseInt(value, 10, 64)
			valid = err == nil && float64(n) >= spec.min && float64(n) <= spec.max
			if valid {
				value = strconv.FormatInt(n, 10)
			}
		case "float":
			n, err := strconv.ParseFloat(value, 64)
			valid = err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= spec.min && n <= spec.max
			if valid {
				value = strconv.FormatFloat(n, 'g', -1, 64)
			}
		case "bool":
			valid = value == "true" || value == "false"
		case "enum":
			valid = contains(spec.options, value)
		case "identifier":
			valid = identifierPattern.MatchString(value)
		case "date":
			_, err := time.Parse(time.DateOnly, value)
			valid = err == nil
		case "datetime":
			_, err := parseDate(value)
			valid = err == nil
		case "timezone":
			_, err := time.LoadLocation(value)
			valid = err == nil
		}
		if !valid {
			return nil, fmt.Errorf("%w: parameter %q", ErrInvalidRequest, key)
		}
		validated.Set(key, value)
	}
	for key, spec := range allowed {
		if validated.Get(key) == "" {
			if spec.required {
				return nil, fmt.Errorf("%w: parameter %q is required", ErrInvalidRequest, key)
			}
			if spec.def != "" {
				validated.Set(key, spec.def)
			}
		}
	}
	if validated.Get("first") != "" && validated.Get("last") != "" || validated.Get("after") != "" && validated.Get("before") != "" || validated.Get("first") != "" && validated.Get("before") != "" || validated.Get("last") != "" && validated.Get("after") != "" {
		return nil, fmt.Errorf("%w: incompatible pagination parameters", ErrInvalidRequest)
	}
	if from, to := validated.Get("from"), validated.Get("to"); from != "" && to != "" {
		start, _ := parseDate(from)
		end, _ := parseDate(to)
		if start.After(end) || end.Sub(start) > 3660*24*time.Hour {
			return nil, fmt.Errorf("%w: date interval", ErrInvalidRequest)
		}
	}
	return validated, nil
}

func safeParameterName(key string) string {
	if !identifierPattern.MatchString(key) {
		return "unknown"
	}
	return key
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func parseDate(value string) (time.Time, error) {
	if len(value) == len(time.DateOnly) {
		return time.Parse(time.DateOnly, value)
	}
	return time.Parse(time.RFC3339Nano, value)
}

func historical(params url.Values) bool {
	if params.Get("after") != "" || params.Get("before") != "" || params.Get("cursor") != "" {
		return true
	}
	value := params.Get("to")
	end, err := parseDate(value)
	if err != nil {
		return false
	}
	if len(value) == len(time.DateOnly) {
		if timezone := params.Get("timezone"); timezone != "" {
			if location, err := time.LoadLocation(timezone); err == nil {
				end, _ = time.ParseInLocation(time.DateOnly, value, location)
				end = end.AddDate(0, 0, 1)
			}
		} else {
			// A date without a zone must have ended even in UTC-12.
			end = end.Add(36 * time.Hour)
		}
	}
	return end.Before(time.Now())
}

func periodInput(params url.Values) (map[string]any, error) {
	period := map[string]any{}
	from, to := params.Get("from"), params.Get("to")
	if from != "" || to != "" {
		if params.Get("period") != "" || params.Get("count") != "" || params.Get("unit") != "" {
			return nil, fmt.Errorf("%w: choose a relative period or date interval", ErrInvalidRequest)
		}
		if from != "" {
			period["from"] = from
		}
		if to != "" {
			period["to"] = to
		}
	} else if named := params.Get("period"); named != "" {
		if params.Get("count") != "" || params.Get("unit") != "" {
			return nil, fmt.Errorf("%w: choose period or count/unit", ErrInvalidRequest)
		}
		period["count"], period["unit"] = 1, named
	} else if count, unit := params.Get("count"), params.Get("unit"); count != "" || unit != "" {
		if count == "" || unit == "" {
			return nil, fmt.Errorf("%w: count and unit are required together", ErrInvalidRequest)
		}
		period["count"], _ = strconv.Atoi(count)
		period["unit"] = unit
	}
	if timezone := params.Get("timezone"); timezone != "" {
		if from == "" && to == "" {
			return nil, fmt.Errorf("%w: timezone requires a date interval", ErrInvalidRequest)
		}
		period["timezone"] = timezone
	}
	if len(period) == 0 {
		return nil, nil
	}
	return period, nil
}

func parameters(spec rules) []Parameter {
	keys := make([]string, 0, len(spec))
	for key := range spec {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]Parameter, 0, len(keys))
	for _, key := range keys {
		r := spec[key]
		p := Parameter{Name: key, Type: "string", Required: r.required}
		switch r.kind {
		case "bool":
			p.Type = "boolean"
		case "int", "float":
			p.Type = "number"
		}
		if r.def != "" {
			p.Default = r.def
		}
		if r.kind == "enum" {
			p.Options = append([]string(nil), r.options...)
		}
		result = append(result, p)
	}
	return result
}
