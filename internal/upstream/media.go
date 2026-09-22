package upstream

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/TheOutdoorProgrammer/farts/internal/archive"
	"go.opentelemetry.io/otel"
)

func (c *Client) mediaKind(raw string) (string, string, bool) {
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "media.birdweather.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || strings.Contains(u.Path, "..") {
		return "", "", false
	}
	switch {
	case strings.HasPrefix(u.Path, "/soundscapes/"+c.StationID+"/"):
		return u.String(), "audio", true
	case strings.HasPrefix(u.Path, "/species/"):
		if strings.HasSuffix(u.Path, ".geojson.gz") || strings.HasSuffix(u.Path, ".geojson") || strings.HasSuffix(u.Path, ".json.gz") {
			return u.String(), "range", true
		}
		return u.String(), "image", true
	}
	return "", "", false
}

func (c *Client) Rewrite(data []byte, exposeLocation bool) ([]byte, error) {
	value, err := decode(data)
	if err != nil {
		return nil, err
	}
	var walk func(any) (any, error)
	walk = func(value any) (any, error) {
		switch value := value.(type) {
		case map[string]any:
			for k, v := range value {
				switch k {
				case "favoriteUrl", "flagUrl", "voteUrl", "token", "authToken", "authenticationToken":
					delete(value, k)
					continue
				}
				if !exposeLocation {
					switch k {
					case "coords", "lat", "lon", "latitude", "longitude", "locationHistory":
						value[k] = nil
						continue
					}
				}
				next, err := walk(v)
				if err != nil {
					return nil, err
				}
				value[k] = next
			}
		case []any:
			for i, v := range value {
				next, err := walk(v)
				if err != nil {
					return nil, err
				}
				value[i] = next
			}
		case string:
			if source, kind, ok := c.mediaKind(value); ok {
				id, err := c.Store.RegisterMedia(source, kind)
				if err != nil {
					return nil, err
				}
				return "/media/" + id, nil
			}
		}
		return value, nil
	}
	value, err = walk(value)
	if err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

func (c *Client) Media(ctx context.Context, id string) (archive.Media, error) {
	media, err := c.Store.Media(id)
	if err != nil {
		return media, err
	}
	if media.Hash != "" {
		return media, nil
	}
	result := c.group.DoChan("media:"+id, func() (any, error) {
		select {
		case c.workers <- struct{}{}:
			defer func() { <-c.workers }()
		default:
			return nil, &HTTPError{Status: http.StatusServiceUnavailable}
		}
		shared, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
		defer cancel()
		shared, span := otel.Tracer("farts.upstream").Start(shared, "birdweather.media")
		defer span.End()
		current, err := c.Store.Media(id)
		if err != nil {
			return nil, err
		}
		if current.Hash != "" {
			return current, nil
		}
		if _, _, ok := c.mediaKind(current.URL); !ok {
			return nil, errors.New("unsupported media source")
		}
		release, err := c.acquire(shared)
		if err != nil {
			return nil, err
		}
		defer release()
		req, err := http.NewRequestWithContext(shared, http.MethodGet, current.URL, nil)
		if err != nil {
			return nil, errors.New("invalid media request")
		}
		req.Header.Set("User-Agent", "FARTS/1 (+https://github.com/TheOutdoorProgrammer/farts)")
		req.Header.Set("Accept-Encoding", "identity")
		response, err := c.HTTP.Do(req)
		if err != nil {
			return nil, errors.New("media request failed")
		}
		defer response.Body.Close()
		c.backoff(response)
		if response.StatusCode != http.StatusOK {
			return nil, &HTTPError{Status: response.StatusCode}
		}
		if response.ContentLength > c.MaxMediaBytes {
			return nil, errors.New("media exceeds configured size limit")
		}
		reader := bufio.NewReader(response.Body)
		header, err := reader.Peek(512)
		if err != nil && err != io.EOF && err != bufio.ErrBufferFull {
			return nil, errors.New("media response incomplete")
		}
		contentType, err := mediaType(current.Kind, header, response.Header.Get("Content-Type"))
		if err != nil {
			return nil, err
		}
		return c.Store.SaveMedia(shared, current, reader, contentType, c.MaxMediaBytes)
	})
	select {
	case <-ctx.Done():
		return archive.Media{}, ctx.Err()
	case result := <-result:
		if result.Err != nil {
			return archive.Media{}, result.Err
		}
		return result.Val.(archive.Media), nil
	}
}

func mediaType(kind string, header []byte, declared string) (string, error) {
	detected := http.DetectContentType(header)
	switch kind {
	case "audio":
		if len(header) >= 4 && string(header[:4]) == "fLaC" {
			return "audio/flac", nil
		}
		if strings.HasPrefix(detected, "audio/") {
			return detected, nil
		}
	case "image":
		switch detected {
		case "image/jpeg", "image/png", "image/gif", "image/webp":
			return detected, nil
		}
		if len(header) >= 12 && string(header[4:8]) == "ftyp" && strings.Contains(string(header[8:min(len(header), 32)]), "avif") {
			return "image/avif", nil
		}
	case "range":
		if len(header) >= 2 && header[0] == 0x1f && header[1] == 0x8b {
			return "application/gzip", nil
		}
		t, _, _ := mime.ParseMediaType(declared)
		if t == "application/geo+json" || t == "application/json" {
			return t, nil
		}
	}
	return "", errors.New("upstream media has an unsupported file signature")
}

func MediaFilename(media archive.Media) string {
	u, err := url.Parse(media.URL)
	if err != nil {
		return "recording"
	}
	return path.Base(u.Path)
}
