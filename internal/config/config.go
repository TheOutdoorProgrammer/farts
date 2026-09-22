package config

import (
	"errors"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var IDPattern = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)

type Config struct {
	StationID          string
	StationToken       string
	StationName        string
	StationDescription string
	Timezone           string
	ListenAddr         string
	DataDir            string
	WebDir             string
	PublicURL          string
	FaroURL            string
	ExposeLocation     bool
	MaxMediaBytes      int64
	Version            string
}

func Load(version string) (Config, error) {
	c := Config{StationID: os.Getenv("FARTS_STATION_ID"), StationToken: os.Getenv("FARTS_STATION_TOKEN"), StationName: os.Getenv("FARTS_STATION_NAME"), StationDescription: os.Getenv("FARTS_STATION_DESCRIPTION"), Timezone: os.Getenv("FARTS_TIMEZONE"), ListenAddr: env("FARTS_LISTEN_ADDR", ":8080"), DataDir: env("FARTS_DATA_DIR", "./data"), WebDir: env("FARTS_WEB_DIR", "./dist"), PublicURL: strings.TrimRight(os.Getenv("FARTS_PUBLIC_URL"), "/"), FaroURL: os.Getenv("FARTS_FARO_URL"), MaxMediaBytes: 64 << 20, Version: version}
	if !IDPattern.MatchString(c.StationID) {
		return c, errors.New("FARTS_STATION_ID must be one positive numeric station ID")
	}
	if c.Timezone != "" {
		if _, err := time.LoadLocation(c.Timezone); err != nil {
			return c, errors.New("FARTS_TIMEZONE must be a valid IANA timezone")
		}
	}
	if len(c.StationName) > 200 || len(c.StationDescription) > 2000 {
		return c, errors.New("station name or description is too long")
	}
	if c.PublicURL != "" {
		u, err := url.Parse(c.PublicURL)
		if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
			return c, errors.New("FARTS_PUBLIC_URL must be an HTTP(S) origin")
		}
	}
	if c.FaroURL != "" {
		u, err := url.Parse(c.FaroURL)
		if err != nil || u.Host == "" || u.User != nil || u.Scheme != "https" {
			return c, errors.New("FARTS_FARO_URL must be an HTTPS collector URL")
		}
	}
	if raw := os.Getenv("FARTS_EXPOSE_LOCATION"); raw != "" {
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return c, errors.New("invalid FARTS_EXPOSE_LOCATION")
		}
		c.ExposeLocation = v
	}
	if raw := os.Getenv("FARTS_MAX_MEDIA_BYTES"); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 1024 || v > 1<<30 {
			return c, errors.New("FARTS_MAX_MEDIA_BYTES must be between 1024 and 1073741824")
		}
		c.MaxMediaBytes = v
	}
	return c, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
