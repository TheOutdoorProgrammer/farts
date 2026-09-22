package archive

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArchiveSurvivesRestartAndRejectsAnotherStation(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir, "42")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	first, err := store.SaveResponse(ctx, "feed", strings.NewReader(`{"detections":[1]}`))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.SaveResponse(ctx, "feed", strings.NewReader(`{"detections":[2]}`))
	if err != nil {
		t.Fatal(err)
	}
	if first.Hash == second.Hash {
		t.Fatal("changed responses lost their identity")
	}
	id, err := store.RegisterMedia("https://media.birdweather.com/soundscapes/42/test.flac", "audio")
	if err != nil {
		t.Fatal(err)
	}
	media, _ := store.Media(id)
	if _, err = store.SaveMedia(ctx, media, strings.NewReader("fLaCtest"), "audio/flac", 100); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	if other, err := Open(dir, "43"); err == nil {
		other.Close()
		t.Fatal("accepted a different station on the same volume")
	}
	store, err = Open(dir, "42")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, body, err := store.Response(ctx, "feed")
	if err != nil || string(body) != `{"detections":[2]}` {
		t.Fatalf("latest response: %s %v", body, err)
	}
	f, err := store.OpenObject(first.Hash)
	if err != nil {
		t.Fatal("lost earlier snapshot", err)
	}
	f.Close()
	media, err = store.Media(id)
	if err != nil || media.Hash == "" {
		t.Fatal("lost media", err)
	}
	stats, err := store.Stats(ctx)
	if err != nil || stats.Responses != 1 || stats.Snapshots != 2 || stats.MediaFiles != 1 || stats.MediaBytes != 8 {
		t.Fatalf("bad archive stats: %+v %v", stats, err)
	}
}

type brokenReader struct{}

func (brokenReader) Read([]byte) (int, error) { return 0, errors.New("connection lost") }

func TestIncompleteObjectsAreNeverPublished(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir, "42")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.PutObject(bytes.NewReader(make([]byte, 101)), 100); err == nil {
		t.Fatal("oversized object accepted")
	}
	if _, err := store.PutObject(io.MultiReader(strings.NewReader("prefix"), brokenReader{}), 100); err == nil {
		t.Fatal("partial download accepted")
	}
	files, err := os.ReadDir(filepath.Join(dir, "objects"))
	if err != nil || len(files) != 0 {
		t.Fatalf("partial objects left behind: %v %v", files, err)
	}
	for _, hash := range []string{"../archive.db", "", strings.Repeat("x", 64)} {
		if f, err := store.OpenObject(hash); err == nil {
			f.Close()
			t.Fatal("unsafe object path accepted")
		}
	}
}

func TestCorruptResponseIsDetected(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir, "42")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	entry, err := store.SaveResponse(context.Background(), "one", strings.NewReader(`{"ok":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "objects", entry.Hash), []byte(`{"ok":false}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.Response(context.Background(), "one"); err == nil {
		t.Fatal("corrupted response served")
	}
}
