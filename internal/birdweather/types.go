package birdweather

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"time"
)

var (
	ErrInvalidRequest = errors.New("invalid BirdWeather request")
	ErrUpstream       = errors.New("invalid BirdWeather response")
	ErrWrongStation   = errors.New("recording does not belong to the configured station")
)

type Request struct {
	Operation string
	Method    string
	Path      string
	Query     url.Values
	Body      []byte
	FreshFor  time.Duration
	Immutable bool
}

type Response struct {
	Body      json.RawMessage
	FetchedAt time.Time
	Stale     bool
}

type Transport interface {
	Do(context.Context, Request) (Response, error)
}

type Client struct {
	stationID string
	transport Transport
}

func New(stationID string, transport Transport) *Client {
	return &Client{stationID: stationID, transport: transport}
}

type Station struct {
	ID                    string   `json:"id"`
	Name                  string   `json:"name"`
	Timezone              string   `json:"timezone"`
	Type                  string   `json:"type,omitempty"`
	Edition               *string  `json:"edition,omitempty"`
	LocationPrivacy       bool     `json:"locationPrivacy"`
	LocationPrivacyRadius int      `json:"locationPrivacyRadius,omitempty"`
	MinConfidence         *float64 `json:"minConfidence,omitempty"`
	MinProbability        *float64 `json:"minProbability,omitempty"`
	MinScore              *float64 `json:"minScore,omitempty"`
	EarliestDetectionAt   *string  `json:"earliestDetectionAt,omitempty"`
	LatestDetectionAt     *string  `json:"latestDetectionAt,omitempty"`
}

type Candidate struct {
	SpeciesID      string  `json:"speciesId"`
	CommonName     string  `json:"commonName"`
	ScientificName string  `json:"scientificName"`
	Weight         float64 `json:"weight"`
}

type Recording struct {
	ID                 string          `json:"id"`
	Timestamp          string          `json:"timestamp"`
	CommonName         string          `json:"commonName"`
	ScientificName     string          `json:"scientificName"`
	SpeciesID          string          `json:"speciesId"`
	Classification     string          `json:"classification"`
	Confidence         float64         `json:"confidence"`
	Probability        *float64        `json:"probability"`
	Score              *float64        `json:"score"`
	Certainty          *string         `json:"certainty"`
	Algorithm          *string         `json:"algorithm"`
	ImageURL           *string         `json:"imageUrl"`
	ImageCredit        *string         `json:"imageCredit"`
	ImageLicense       *string         `json:"imageLicense"`
	ImageLicenseURL    *string         `json:"imageLicenseUrl"`
	ImageSource        *string         `json:"imageSource"`
	Behavior           *string         `json:"behavior"`
	BehaviorCode       *string         `json:"behaviorCode"`
	BehaviorConfidence *float64        `json:"behaviorConfidence"`
	Shortlist          []Candidate     `json:"shortlist"`
	AudioURL           *string         `json:"audioUrl"`
	StartTime          *float64        `json:"startTime"`
	EndTime            *float64        `json:"endTime"`
	Duration           *float64        `json:"duration"`
	SampleRate         *int            `json:"sampleRate"`
	SoundscapeID       *string         `json:"soundscapeId"`
	Raw                json.RawMessage `json:"raw"`
}

type Feed struct {
	Station    Station     `json:"station"`
	Recordings []Recording `json:"recordings"`
	NextCursor *string     `json:"nextCursor"`
	FetchedAt  time.Time   `json:"fetchedAt"`
	Stale      bool        `json:"stale"`
}

type Section struct {
	Data      json.RawMessage `json:"data"`
	FetchedAt *time.Time      `json:"fetchedAt"`
	Stale     bool            `json:"stale"`
	Error     string          `json:"error,omitempty"`
}

type Dashboard struct {
	Station   Station            `json:"station"`
	Sections  map[string]Section `json:"sections"`
	FetchedAt time.Time          `json:"fetchedAt"`
	Stale     bool               `json:"stale"`
}

type Parameter struct {
	Name     string   `json:"name"`
	Label    string   `json:"label,omitempty"`
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Default  any      `json:"default,omitempty"`
	Options  []string `json:"options,omitempty"`
}

type Capability struct {
	ID          string      `json:"id"`
	Label       string      `json:"label"`
	Description string      `json:"description"`
	Path        string      `json:"path"`
	Method      string      `json:"method"`
	Parameters  []Parameter `json:"parameters"`
}

type CapabilityList struct {
	Operations []Capability `json:"operations"`
}
