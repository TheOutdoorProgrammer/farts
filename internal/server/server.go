package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/TheOutdoorProgrammer/farts/internal/archive"
	"github.com/TheOutdoorProgrammer/farts/internal/birdweather"
	"github.com/TheOutdoorProgrammer/farts/internal/config"
	"github.com/TheOutdoorProgrammer/farts/internal/upstream"
)

type Server struct {
	config      config.Config
	store       *archive.Store
	upstream    *upstream.Client
	api         *birdweather.Client
	concurrency chan struct{}
}

func New(cfg config.Config, store *archive.Store) *Server {
	client := upstream.New(store, cfg.StationID, cfg.StationToken, cfg.MaxMediaBytes)
	return &Server{config: cfg, store: store, upstream: client, api: birdweather.New(cfg.StationID, client), concurrency: make(chan struct{}, 64)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := s.store.Ping(r.Context()); err != nil {
			jsonError(w, 503, "Archive storage is not writable.")
			return
		}
		jsonResponse(w, 200, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("GET /api/config", s.configuration)
	mux.HandleFunc("GET /api/capabilities", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, birdweather.Capabilities()) })
	mux.HandleFunc("GET /api/archive", func(w http.ResponseWriter, r *http.Request) {
		stats, err := s.store.Stats(r.Context())
		if err != nil {
			s.fail(w, r, err)
			return
		}
		jsonResponse(w, 200, stats)
	})
	mux.HandleFunc("GET /api/feed", func(w http.ResponseWriter, r *http.Request) {
		s.respond(w, r, func() (birdweather.Response, error) { return s.api.Feed(r.Context(), r.URL.Query()) })
	})
	mux.HandleFunc("GET /api/dashboard", func(w http.ResponseWriter, r *http.Request) {
		s.respond(w, r, func() (birdweather.Response, error) { return s.api.Dashboard(r.Context(), r.URL.Query()) })
	})
	mux.HandleFunc("GET /api/recordings/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.respond(w, r, func() (birdweather.Response, error) { return s.api.Recording(r.Context(), r.PathValue("id")) })
	})
	mux.HandleFunc("GET /api/birdweather/{resource}", s.rest)
	mux.HandleFunc("GET /api/birdweather/{resource}/{id}", s.rest)
	mux.HandleFunc("GET /api/graphql/{operation}", s.graphql)
	mux.HandleFunc("GET /api/", func(w http.ResponseWriter, r *http.Request) { jsonError(w, 404, "Unknown API operation.") })
	mux.HandleFunc("GET /media/{id}", s.media)
	mux.HandleFunc("GET /recordings/{id}", s.sharePage)
	mux.HandleFunc("GET /", s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.headers(w)
		if len(r.URL.RawQuery) > 8192 {
			jsonError(w, 414, "The query is too long.")
			return
		}
		if r.ContentLength > 0 && r.Method == http.MethodGet {
			jsonError(w, 400, "GET requests must not include a body.")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/media/") || strings.HasPrefix(r.URL.Path, "/recordings/") {
			select {
			case s.concurrency <- struct{}{}:
				defer func() { <-s.concurrency }()
			default:
				w.Header().Set("Retry-After", "5")
				jsonError(w, 503, "The station is busy. Please try again shortly.")
				return
			}
		}
		defer func() {
			if recover() != nil {
				slog.ErrorContext(r.Context(), "HTTP handler panic")
				jsonError(w, 500, "The station could not complete this request.")
			}
		}()
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) headers(w http.ResponseWriter) {
	collector := ""
	if u, err := url.Parse(s.config.FaroURL); err == nil && u.Scheme == "https" && u.Host != "" {
		collector = " " + u.Scheme + "://" + u.Host
	}
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'"+collector+"; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Cache-Control", "no-store")
	if strings.HasPrefix(s.config.PublicURL, "https://") {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
	}
}

func (s *Server) configuration(w http.ResponseWriter, r *http.Request) {
	name := s.config.StationName
	zone := s.config.Timezone
	if response, err := s.api.GraphQL(r.Context(), "station", url.Values{}); err == nil {
		var value map[string]any
		if json.Unmarshal(response.Body, &value) == nil {
			station := nestedStation(value)
			if name == "" {
				name, _ = station["name"].(string)
			}
			if zone == "" {
				zone, _ = station["timezone"].(string)
			}
		}
	}
	if name == "" {
		name = "Our wildlife station"
	}
	if zone == "" {
		zone = "UTC"
	}
	jsonResponse(w, 200, map[string]any{"name": "FARTS", "stationId": s.config.StationID, "stationName": name, "stationDescription": s.config.StationDescription, "timezone": zone, "version": s.config.Version, "faroUrl": s.config.FaroURL, "publicUrl": s.config.PublicURL, "exposeLocation": s.config.ExposeLocation})
}

func nestedStation(value map[string]any) map[string]any {
	if station, ok := value["station"].(map[string]any); ok {
		return station
	}
	if data, ok := value["data"].(map[string]any); ok {
		return nestedStation(data)
	}
	return value
}

func (s *Server) rest(w http.ResponseWriter, r *http.Request) {
	resource, id := r.PathValue("resource"), r.PathValue("id")
	if resource == "species" && id != "" && !s.speciesAllowed(r.Context(), id) {
		jsonError(w, 404, "This species has not been recorded at this station.")
		return
	}
	if resource == "species-lookup" && !s.speciesListAllowed(r.Context(), r.URL.Query().Get("ids")) {
		jsonError(w, 404, "The requested species are not part of this station.")
		return
	}
	s.respond(w, r, func() (birdweather.Response, error) { return s.api.REST(r.Context(), resource, id, r.URL.Query()) })
}

func (s *Server) graphql(w http.ResponseWriter, r *http.Request) {
	operation := r.PathValue("operation")
	if strings.HasPrefix(operation, "species-") && operation != "species-search" {
		ids := r.URL.Query().Get("ids")
		if ids == "" {
			ids = r.URL.Query().Get("speciesId")
		}
		if ids == "" {
			ids = r.URL.Query().Get("id")
		}
		if !s.speciesListAllowed(r.Context(), ids) {
			jsonError(w, 404, "The requested species are not part of this station.")
			return
		}
	}
	s.respond(w, r, func() (birdweather.Response, error) { return s.api.GraphQL(r.Context(), operation, r.URL.Query()) })
}

func (s *Server) speciesListAllowed(ctx context.Context, ids string) bool {
	list := strings.Split(ids, ",")
	if len(list) > 50 {
		return false
	}
	for _, id := range list {
		if !s.speciesAllowed(ctx, id) {
			return false
		}
	}
	return true
}

func (s *Server) speciesAllowed(ctx context.Context, id string) bool {
	if !config.IDPattern.MatchString(id) {
		return false
	}
	if s.store.HasSpecies(id) {
		return true
	}
	_, err := s.api.REST(ctx, "species", "", url.Values{"speciesId": {id}, "period": {"all"}, "limit": {"1"}})
	return err == nil && s.store.HasSpecies(id)
}

func (s *Server) respond(w http.ResponseWriter, r *http.Request, request func() (birdweather.Response, error)) {
	response, err := request()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	body, err := s.upstream.Rewrite(response.Body, s.config.ExposeLocation)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-FARTS-Fetched-At", response.FetchedAt.UTC().Format(time.RFC3339Nano))
	if response.Stale {
		w.Header().Set("X-FARTS-Stale", "true")
		w.Header().Set("Warning", `110 farts "Serving saved data while BirdWeather is unavailable"`)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, context.Canceled):
		return
	case errors.Is(err, birdweather.ErrInvalidRequest):
		jsonError(w, 400, "Unsupported or invalid request parameters.")
	case errors.Is(err, archive.ErrNotFound):
		jsonError(w, 404, "This resource is not in this station's archive.")
	case errors.Is(err, birdweather.ErrWrongStation):
		jsonError(w, 404, "This recording does not belong to this station.")
	default:
		var upstreamError *upstream.HTTPError
		if errors.As(err, &upstreamError) && (upstreamError.Status == 404 || upstreamError.Status == 410) {
			jsonError(w, 404, "BirdWeather does not have this resource, and it has not been saved here.")
			return
		}
		if errors.As(err, &upstreamError) && upstreamError.Status == 429 {
			w.Header().Set("Retry-After", "30")
			jsonError(w, 503, "BirdWeather requested a pause. Please try again shortly.")
			return
		}
		slog.ErrorContext(r.Context(), "station operation failed", "http_route", r.Pattern)
		jsonError(w, 502, "This information could not be loaded. Saved recordings are still available.")
	}
}

func (s *Server) media(w http.ResponseWriter, r *http.Request) {
	media, err := s.upstream.Media(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	f, err := s.store.OpenObject(media.Hash)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", media.ContentType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+media.Hash+`"`)
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": upstream.MediaFilename(media)}))
	http.ServeContent(w, r, upstream.MediaFilename(media), media.FetchedAt, f)
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	for _, part := range strings.Split(r.URL.Path, "/") {
		if strings.HasPrefix(part, ".") {
			http.NotFound(w, r)
			return
		}
	}
	clean := filepath.Clean("/" + r.URL.Path)
	filename := filepath.Join(s.config.WebDir, clean)
	if r.URL.Path != "/" {
		if info, err := os.Stat(filename); err == nil && !info.IsDir() {
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			http.ServeFile(w, r, filename)
			return
		}
	}
	if strings.HasPrefix(r.URL.Path, "/assets/") || filepath.Ext(r.URL.Path) != "" {
		http.NotFound(w, r)
		return
	}
	s.html(w, r, nil)
}

func (s *Server) sharePage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !config.IDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	response, err := s.api.Recording(r.Context(), id)
	if err != nil {
		s.html(w, r, nil)
		return
	}
	body, err := s.upstream.Rewrite(response.Body, s.config.ExposeLocation)
	if err != nil {
		s.html(w, r, nil)
		return
	}
	var recording map[string]any
	if json.Unmarshal(body, &recording) != nil {
		s.html(w, r, nil)
		return
	}
	s.html(w, r, recording)
}

var titlePattern = regexp.MustCompile(`(?s)<title>.*?</title>`)
var previewPattern = regexp.MustCompile(`(?i)<meta\s+[^>]*(?:property|name)=["'](?:og:[^"']*|twitter:[^"']*|description)["'][^>]*>`)

func (s *Server) html(w http.ResponseWriter, r *http.Request, recording map[string]any) {
	data, err := os.ReadFile(filepath.Join(s.config.WebDir, "index.html"))
	if err != nil {
		jsonError(w, 503, "The website assets are unavailable. Build the frontend first.")
		return
	}
	name := s.config.StationName
	if name == "" {
		name = "Our wildlife station"
	}
	title := name + " · FARTS"
	description := s.config.StationDescription
	if description == "" {
		description = "Listen to the birds and bats around our station. Discover and share a little of the wild."
	}
	imageURL := ""
	if recording != nil {
		if species, ok := recording["commonName"].(string); ok {
			title = species + " · " + name
			description = "Listen to " + species + ", recorded at " + name + "."
		}
		if image, ok := recording["imageUrl"].(string); ok && strings.HasPrefix(image, "/media/") {
			imageURL = s.config.PublicURL + image
		}
	}
	page := previewPattern.ReplaceAllString(string(data), "")
	page = titlePattern.ReplaceAllStringFunc(page, func(string) string { return "<title>" + html.EscapeString(title) + "</title>" })
	meta := fmt.Sprintf(`<meta name="description" content="%s"><meta property="og:title" content="%s"><meta property="og:description" content="%s"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">`, html.EscapeString(description), html.EscapeString(title), html.EscapeString(description))
	if s.config.PublicURL != "" {
		meta += `<meta property="og:url" content="` + html.EscapeString(s.config.PublicURL+r.URL.EscapedPath()) + `">`
	}
	if imageURL != "" {
		meta += `<meta property="og:image" content="` + html.EscapeString(imageURL) + `">`
	}
	page = strings.Replace(page, "</head>", meta+"</head>", 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, page)
}

func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func jsonError(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]any{"error": message})
}
