package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"html"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/TheOutdoorProgrammer/farts/internal/config"
	"go.opentelemetry.io/otel"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

const brandExpansion = "Flying Animal Recon and Telemetry Service"

type preview struct {
	Title, Description, Canonical, ImageURL, ImageAlt string
	Station, Heading, Scientific, Detail, Label       string
	Timestamp                                         string
	Recording                                         bool
}

var (
	titlePattern      = regexp.MustCompile(`(?is)<title>.*?</title>`)
	previewPattern    = regexp.MustCompile(`(?i)<meta\s+[^>]*(?:property|name)=["'](?:og:[^"']*|twitter:[^"']*|description|date)["'][^>]*>|<link\s+[^>]*rel=["']canonical["'][^>]*>`)
	previewBold, _    = opentype.Parse(gobold.TTF)
	previewRegular, _ = opentype.Parse(goregular.TTF)
)

func canonicalQuery(input url.Values) url.Values {
	result := url.Values{}
	for key, allowed := range map[string]string{
		"view":           "journal|species|activity|station|data",
		"period":         "day|week|month|all",
		"classification": "all|bird|bat",
	} {
		value := input.Get(key)
		for _, candidate := range strings.Split(allowed, "|") {
			if value == candidate {
				result.Set(key, value)
			}
		}
	}
	if id := input.Get("speciesId"); config.IDPattern.MatchString(id) {
		result.Set("speciesId", id)
	}
	for _, key := range []string{"from", "to"} {
		if value := input.Get(key); len(value) == 10 {
			if _, err := time.Parse(time.DateOnly, value); err == nil {
				result.Set(key, value)
			}
		}
	}
	query := strings.TrimSpace(input.Get("query"))
	if utf8.ValidString(query) && utf8.RuneCountInString(query) <= 160 && !strings.ContainsFunc(query, unicode.IsControl) && query != "" {
		result.Set("query", query)
	}
	return result
}

func (s *Server) preview(r *http.Request, recording map[string]any) preview {
	station, timezone := s.stationIdentity(r.Context())
	p := preview{Station: station, Heading: station, Title: station + " · FARTS", Label: "A FAMILY FIELD JOURNAL", Detail: "Birds by day. Bats after dark."}
	p.Description = s.config.StationDescription
	if p.Description == "" {
		p.Description = "Listen to the birds and bats around our station. Discover and share a little of the wild."
	}
	pagePath, imagePath := "/", "/og/station.png"
	query := canonicalQuery(r.URL.Query())
	if view := query.Get("view"); view != "" && view != "journal" {
		name := map[string]string{"species": "Species", "activity": "Activity", "station": "The station", "data": "Explore data"}[view]
		p.Title = name + " · " + p.Title
		p.Label = strings.ToUpper(name)
	}
	if classification := query.Get("classification"); classification == "bird" || classification == "bat" {
		p.Label += " · " + strings.ToUpper(classification) + "S"
	}
	if strings.HasPrefix(r.URL.Path, "/recordings/") {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/recordings/"), "/")
		if config.IDPattern.MatchString(id) {
			pagePath = "/recordings/" + id
			if recording != nil {
				imagePath = "/og/recordings/" + id + ".png"
			}
			query = url.Values{}
		}
	}
	if recording != nil {
		p.Recording = true
		p.Label = "A MOMENT IN THE WILD"
		if species := previewString(recording, "commonName"); species != "" {
			p.Heading = species
			p.Title = species + " · " + station + " · FARTS"
			p.Description = "Listen to " + species + ", recorded at " + station + "."
		}
		p.Scientific = previewString(recording, "scientificName")
		p.Detail = station
		if timestamp, err := time.Parse(time.RFC3339Nano, previewString(recording, "timestamp")); err == nil {
			location := timestamp.Location()
			if timezone != "" {
				if configured, err := time.LoadLocation(timezone); err == nil {
					location = configured
				}
			}
			local := timestamp.In(location)
			p.Timestamp = local.Format(time.RFC3339)
			zone, _ := local.Zone()
			if zone == "" {
				zone = "UTC" + local.Format("-07:00")
			}
			p.Detail = local.Format("Jan 2, 2006 · 3:04 PM ") + zone
			p.Description += " Recorded " + local.Format("January 2, 2006 at 3:04 PM ") + zone + "."
		}
		if previewString(recording, "classification") == "bat" {
			p.Description += " Hear the ultrasonic calls slowed 10×."
		}
	}
	p.ImageAlt = p.Heading + ". " + p.Detail + ". FARTS: " + brandExpansion + "."
	if s.config.PublicURL != "" {
		p.Canonical = s.config.PublicURL + pagePath
		if len(query) > 0 {
			p.Canonical += "?" + query.Encode()
		}
		p.ImageURL = s.config.PublicURL + imagePath
		if s.config.Version != "" {
			query.Set("v", s.config.Version)
		}
		if len(query) > 0 {
			p.ImageURL += "?" + query.Encode()
		}
	}
	return p
}

func previewString(value map[string]any, key string) string {
	result, _ := value[key].(string)
	runes := []rune(strings.TrimSpace(result))
	if len(runes) > 300 {
		runes = runes[:300]
	}
	return string(runes)
}

func (s *Server) recordingPreview(ctx context.Context, id string) (map[string]any, error) {
	response, err := s.api.Recording(ctx, id)
	if err != nil {
		return nil, err
	}
	var recording map[string]any
	err = json.Unmarshal(response.Body, &recording)
	return recording, err
}

func (s *Server) sharePage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !config.IDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	recording, _ := s.recordingPreview(r.Context(), id)
	s.html(w, r, recording)
}

func (s *Server) html(w http.ResponseWriter, r *http.Request, recording map[string]any) {
	data, err := os.ReadFile(filepath.Join(s.config.WebDir, "index.html"))
	if err != nil {
		jsonError(w, 503, "The website assets are unavailable. Build the frontend first.")
		return
	}
	p := s.preview(r, recording)
	page := previewPattern.ReplaceAllString(string(data), "")
	page = titlePattern.ReplaceAllStringFunc(page, func(string) string { return "<title>" + html.EscapeString(p.Title) + "</title>" })
	var metadata strings.Builder
	tag := func(attribute, key, value string) {
		if value != "" {
			fmt.Fprintf(&metadata, `<meta %s="%s" content="%s">`, attribute, key, html.EscapeString(value))
		}
	}
	tag("name", "description", p.Description)
	for _, item := range [][2]string{{"og:title", p.Title}, {"og:description", p.Description}, {"og:type", "website"}, {"og:site_name", "FARTS"}, {"og:locale", "en_US"}, {"og:url", p.Canonical}, {"og:image", p.ImageURL}} {
		tag("property", item[0], item[1])
	}
	if p.ImageURL != "" {
		for _, item := range [][2]string{{"og:image:type", "image/png"}, {"og:image:width", "1200"}, {"og:image:height", "630"}, {"og:image:alt", p.ImageAlt}} {
			tag("property", item[0], item[1])
		}
		if strings.HasPrefix(p.ImageURL, "https://") {
			tag("property", "og:image:secure_url", p.ImageURL)
		}
	}
	for _, item := range [][2]string{{"twitter:card", "summary_large_image"}, {"twitter:title", p.Title}, {"twitter:description", p.Description}, {"twitter:image", p.ImageURL}, {"twitter:image:alt", p.ImageAlt}, {"date", p.Timestamp}} {
		tag("name", item[0], item[1])
	}
	if p.Canonical != "" {
		fmt.Fprintf(&metadata, `<link rel="canonical" href="%s">`, html.EscapeString(p.Canonical))
	}
	page = strings.Replace(page, "</head>", metadata.String()+"</head>", 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, page)
}

func (s *Server) previewImage(w http.ResponseWriter, r *http.Request) {
	select {
	case s.previewConcurrency <- struct{}{}:
		defer func() { <-s.previewConcurrency }()
	default:
		w.Header().Set("Retry-After", "5")
		jsonError(w, 503, "Share previews are busy. Please try again shortly.")
		return
	}
	ctx, span := otel.Tracer("farts.preview").Start(r.Context(), "preview.render")
	defer span.End()
	var recording map[string]any
	pageRequest := r.Clone(ctx)
	pageRequest.URL.Path = "/"
	if rawID := r.PathValue("id"); rawID != "" {
		id := strings.TrimSuffix(rawID, ".png")
		if !strings.HasSuffix(rawID, ".png") || !config.IDPattern.MatchString(id) {
			http.NotFound(w, r)
			return
		}
		var err error
		recording, err = s.recordingPreview(ctx, id)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		pageRequest.URL.Path = "/recordings/" + id
	}
	data, err := renderPreview(s.preview(pageRequest, recording))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sum := sha256.Sum256(data)
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("ETag", fmt.Sprintf(`"%x"`, sum))
	http.ServeContent(w, r, "farts-preview.png", time.Time{}, bytes.NewReader(data))
}

func renderPreview(p preview) ([]byte, error) {
	canvas := image.NewRGBA(image.Rect(0, 0, 1200, 630))
	forest := color.RGBA{18, 56, 45, 255}
	paper := color.RGBA{247, 245, 236, 255}
	leaf := color.RGBA{217, 237, 146, 255}
	muted := color.RGBA{192, 210, 181, 255}
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(forest), image.Point{}, draw.Src)
	draw.Draw(canvas, image.Rect(872, 0, 1200, 630), image.NewUniform(paper), image.Point{}, draw.Src)
	draw.Draw(canvas, image.Rect(64, 127, 808, 129), image.NewUniform(color.RGBA{65, 95, 72, 255}), image.Point{}, draw.Src)
	faces := map[int]font.Face{}
	defer func() {
		for _, face := range faces {
			_ = face.Close()
		}
	}()
	face := func(size int, bold bool) font.Face {
		key := size
		if bold {
			key = -size
		}
		if f := faces[key]; f != nil {
			return f
		}
		parsed := previewRegular
		if bold {
			parsed = previewBold
		}
		f, _ := opentype.NewFace(parsed, &opentype.FaceOptions{Size: float64(size), DPI: 72, Hinting: font.HintingFull})
		faces[key] = f
		return f
	}
	text := func(value string, x, y, size, width, lines int, bold bool, ink color.Color) {
		f := face(size, bold)
		for index, line := range previewLines(value, f, width, lines) {
			drawer := font.Drawer{Dst: canvas, Src: image.NewUniform(ink), Face: f, Dot: fixed.P(x, y+index*(size+10))}
			drawer.DrawString(line)
		}
	}
	text("FARTS.", 64, 87, 48, 744, 1, true, paper)
	text("Flying Animal Recon", 294, 65, 18, 480, 1, false, muted)
	text("and Telemetry Service", 294, 91, 18, 480, 1, false, muted)
	text(p.Label, 64, 180, 19, 744, 1, true, leaf)
	text(p.Heading, 60, 262, 61, 744, 2, true, paper)
	if p.Recording {
		text(p.Scientific, 64, 388, 25, 744, 1, false, muted)
		text(p.Station, 64, 435, 25, 744, 1, true, paper)
		text(p.Detail, 64, 472, 23, 744, 1, false, muted)
	} else {
		text(p.Description, 64, 390, 27, 730, 2, false, muted)
	}
	draw.Draw(canvas, image.Rect(64, 523, 371, 579), image.NewUniform(leaf), image.Point{}, draw.Src)
	callToAction := "Explore the wild"
	if p.Recording {
		callToAction = "Listen to this call"
	}
	text(callToAction, 86, 560, 24, 269, 1, true, forest)
	text("GOOD CALLS.", 910, 91, 23, 252, 1, true, forest)
	text("Questionable acronym.", 910, 125, 16, 252, 1, false, forest)
	previewMark(canvas, 923, 219, forest, leaf)
	text("WILDLIFE", 910, 516, 25, 252, 1, true, forest)
	text("worth sharing.", 910, 552, 25, 252, 1, false, forest)
	var output bytes.Buffer
	err := png.Encode(&output, canvas)
	return output.Bytes(), err
}

func previewLines(value string, face font.Face, width, limit int) []string {
	words := strings.Fields(value)
	var lines []string
	line := ""
	for _, word := range words {
		candidate := strings.TrimSpace(line + " " + word)
		if line != "" && font.MeasureString(face, candidate).Ceil() > width {
			lines = append(lines, line)
			line = word
		} else {
			line = candidate
		}
		if len(lines) == limit {
			break
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	truncated := len(lines) > limit
	if truncated {
		lines = lines[:limit]
	}
	for index, line := range lines {
		runes := []rune(line)
		if font.MeasureString(face, line).Ceil() > width || (truncated && index == limit-1) {
			for len(runes) > 0 && font.MeasureString(face, string(runes)+"…").Ceil() > width {
				runes = runes[:len(runes)-1]
			}
			lines[index] = string(runes) + "…"
		}
	}
	return lines
}

func previewMark(canvas *image.RGBA, x, y int, forest, leaf color.Color) {
	draw.Draw(canvas, image.Rect(x, y, x+224, y+224), image.NewUniform(forest), image.Point{}, draw.Src)
	path := vector.NewRasterizer(224, 224)
	path.MoveTo(35, 71)
	path.CubeTo(72, 72, 97, 98, 112, 123)
	path.CubeTo(128, 98, 155, 72, 190, 71)
	path.LineTo(190, 87)
	path.CubeTo(155, 88, 128, 118, 112, 145)
	path.CubeTo(96, 118, 70, 88, 35, 87)
	path.ClosePath()
	path.MoveTo(53, 118)
	path.CubeTo(78, 118, 97, 132, 112, 149)
	path.CubeTo(130, 132, 146, 118, 174, 118)
	path.LineTo(174, 133)
	path.CubeTo(146, 134, 128, 151, 112, 174)
	path.CubeTo(96, 151, 77, 134, 53, 133)
	path.ClosePath()
	path.Draw(canvas, image.Rect(x, y, x+224, y+224), image.NewUniform(leaf), image.Point{})
	draw.Draw(canvas, image.Rect(x+106, y+43, x+119, y+56), image.NewUniform(leaf), image.Point{}, draw.Src)
}
