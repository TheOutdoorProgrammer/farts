package upstream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/TheOutdoorProgrammer/farts/internal/archive"
	"github.com/TheOutdoorProgrammer/farts/internal/birdweather"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"golang.org/x/sync/singleflight"
)

type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return fmt.Sprintf("upstream returned HTTP %d", e.Status) }

type Client struct {
	Store         *archive.Store
	StationID     string
	Token         string
	HTTP          *http.Client
	BaseURL       string
	MaxMediaBytes int64
	group         singleflight.Group
	limit         chan struct{}
	workers       chan struct{}
	mu            sync.Mutex
	retryAt       time.Time
	nextRequest   time.Time
}

func New(store *archive.Store, stationID, token string, maxMediaBytes int64) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxConnsPerHost = 4
	transport.ResponseHeaderTimeout = 20 * time.Second
	return &Client{Store: store, StationID: stationID, Token: token, BaseURL: "https://app.birdweather.com", MaxMediaBytes: maxMediaBytes,
		HTTP: &http.Client{Transport: transport, Timeout: 45 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("upstream redirects are disabled") }}, limit: make(chan struct{}, 4), workers: make(chan struct{}, 64)}
}

func (c *Client) Do(ctx context.Context, request birdweather.Request) (birdweather.Response, error) {
	ctx, span := otel.Tracer("farts.upstream").Start(ctx, "birdweather.request")
	defer span.End()
	span.SetAttributes(attribute.String("birdweather.operation", request.Operation))
	key := archive.Hash([]byte("v1\n" + c.StationID + "\n" + archive.Hash([]byte(c.Token)) + "\n" + request.Method + "\n" + request.Path + "\n" + request.Query.Encode() + "\n" + string(request.Body)))
	entry, body, cacheErr := c.Store.Response(ctx, key)
	if cacheErr == nil && (request.Immutable || time.Since(entry.FetchedAt) < request.FreshFor) {
		span.SetAttributes(attribute.String("cache.result", "hit"))
		return birdweather.Response{Body: body, FetchedAt: entry.FetchedAt}, nil
	}
	if cacheErr != nil && !errors.Is(cacheErr, archive.ErrNotFound) {
		slog.WarnContext(ctx, "archive read failed", "operation", request.Operation)
	}
	result := c.group.DoChan(key, func() (any, error) {
		select {
		case c.workers <- struct{}{}:
			defer func() { <-c.workers }()
		default:
			return nil, &HTTPError{Status: http.StatusServiceUnavailable}
		}
		shared, cancel := context.WithTimeout(context.WithoutCancel(ctx), 55*time.Second)
		defer cancel()
		// A request may have filled the cache between our first read and joining this group.
		latest, latestBody, err := c.Store.Response(shared, key)
		if err == nil && (request.Immutable || time.Since(latest.FetchedAt) < request.FreshFor) {
			return birdweather.Response{Body: latestBody, FetchedAt: latest.FetchedAt}, nil
		}
		data, err := c.fetch(shared, request)
		if err != nil {
			if cacheErr == nil {
				slog.WarnContext(shared, "serving saved data after upstream failure", "operation", request.Operation)
				return birdweather.Response{Body: body, FetchedAt: entry.FetchedAt, Stale: true}, nil
			}
			return nil, err
		}
		saved, err := c.Store.SaveResponse(shared, key, bytes.NewReader(data))
		if err != nil {
			return nil, errors.New("could not persist upstream response")
		}
		return birdweather.Response{Body: data, FetchedAt: saved.FetchedAt}, nil
	})
	select {
	case <-ctx.Done():
		return birdweather.Response{}, ctx.Err()
	case result := <-result:
		if result.Err != nil {
			span.SetStatus(codes.Error, "upstream unavailable")
			return birdweather.Response{}, result.Err
		}
		span.SetAttributes(attribute.String("cache.result", "miss"))
		return result.Val.(birdweather.Response), nil
	}
}

func (c *Client) acquire(ctx context.Context) (func(), error) {
	c.mu.Lock()
	retryAt := c.retryAt
	c.mu.Unlock()
	if time.Now().Before(retryAt) {
		return nil, &HTTPError{Status: http.StatusTooManyRequests}
	}
	select {
	case c.limit <- struct{}{}:
		c.mu.Lock()
		wait := time.Until(c.nextRequest)
		if wait < 0 {
			wait = 0
		}
		c.nextRequest = time.Now().Add(wait + 250*time.Millisecond)
		c.mu.Unlock()
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-timer.C:
			return func() { <-c.limit }, nil
		case <-ctx.Done():
			<-c.limit
			return nil, ctx.Err()
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *Client) backoff(response *http.Response) {
	if response.StatusCode != 429 && response.StatusCode != 503 {
		return
	}
	duration := 30 * time.Second
	if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 {
		duration = time.Duration(min(seconds, 3600)) * time.Second
	} else if at, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil && at.After(time.Now()) {
		duration = min(time.Until(at), time.Hour)
	}
	c.mu.Lock()
	c.retryAt = time.Now().Add(duration)
	c.mu.Unlock()
}

func (c *Client) fetch(ctx context.Context, request birdweather.Request) ([]byte, error) {
	release, err := c.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	if !strings.HasPrefix(request.Path, "/api/v1/") && request.Path != "/graphql" {
		return nil, errors.New("unsupported upstream path")
	}
	if strings.ContainsAny(request.Path, "?#\\") || strings.Contains(request.Path, "..") {
		return nil, errors.New("invalid upstream path")
	}
	requestPath := request.Path
	if c.Token != "" {
		requestPath = strings.Replace(requestPath, "/api/v1/stations/"+c.StationID+"/", "/api/v1/stations/"+url.PathEscape(c.Token)+"/", 1)
	}
	endpoint := c.BaseURL + requestPath
	if len(request.Query) > 0 {
		endpoint += "?" + request.Query.Encode()
	}
	method := request.Method
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(request.Body))
	if err != nil {
		return nil, errors.New("invalid upstream request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "FARTS/1 (+https://github.com/TheOutdoorProgrammer/farts)")
	if len(request.Body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.HTTP.Do(req)
	if err != nil {
		return nil, errors.New("BirdWeather request failed")
	}
	defer response.Body.Close()
	c.backoff(response)
	if response.StatusCode != http.StatusOK {
		return nil, &HTTPError{Status: response.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
	if err != nil || len(data) > 16<<20 {
		return nil, errors.New("invalid upstream response size")
	}
	if err := birdweather.ValidateResponse(request, data, c.StationID); err != nil {
		return nil, err
	}
	ids, err := validate(data, c.StationID)
	if err != nil {
		return nil, err
	}
	if err = c.Store.AddSpecies(ids); err != nil {
		return nil, errors.New("could not persist station species")
	}
	return data, nil
}

func decode(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("upstream returned invalid JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("upstream returned trailing data")
	}
	return value, nil
}

func validate(data []byte, stationID string) ([]string, error) {
	value, err := decode(data)
	if err != nil {
		return nil, err
	}
	root, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("upstream returned an invalid document")
	}
	if success, ok := root["success"].(bool); ok && !success {
		return nil, errors.New("upstream operation was unsuccessful")
	}
	if failures, ok := root["errors"].([]any); ok && len(failures) > 0 {
		return nil, errors.New("upstream GraphQL operation failed")
	}
	ids := map[string]bool{}
	var walk func(any, string) error
	walk = func(value any, key string) error {
		switch value := value.(type) {
		case map[string]any:
			if id, ok := value["stationId"]; ok && fmt.Sprint(id) != stationID {
				return errors.New("upstream returned another station")
			}
			if key == "station" {
				if id, ok := value["id"]; ok && fmt.Sprint(id) != stationID {
					return errors.New("upstream returned another station")
				}
			}
			if id, ok := value["speciesId"]; ok && id != nil {
				ids[fmt.Sprint(id)] = true
			}
			if key == "species" {
				if id, ok := value["id"]; ok && id != nil {
					ids[fmt.Sprint(id)] = true
				}
			}
			for k, v := range value {
				if err := walk(v, k); err != nil {
					return err
				}
			}
		case []any:
			for _, v := range value {
				if err := walk(v, key); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(value, ""); err != nil {
		return nil, err
	}
	list := make([]string, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	return list, nil
}
