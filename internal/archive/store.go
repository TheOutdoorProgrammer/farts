package archive

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	bolt "go.etcd.io/bbolt"
	"go.opentelemetry.io/otel"
)

var ErrNotFound = errors.New("archive entry not found")
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Store struct {
	db  *bolt.DB
	dir string
}

type Entry struct {
	Hash      string    `json:"hash"`
	FetchedAt time.Time `json:"fetchedAt"`
	Size      int64     `json:"size"`
}

type Media struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Kind        string `json:"kind"`
	ContentType string `json:"contentType,omitempty"`
	Entry
}

type Stats struct {
	Responses       int        `json:"responses"`
	Snapshots       int        `json:"snapshots"`
	RegisteredMedia int        `json:"registeredMedia"`
	MediaFiles      int        `json:"mediaFiles"`
	MediaBytes      int64      `json:"mediaBytes"`
	FirstFetchedAt  *time.Time `json:"firstFetchedAt"`
	LastFetchedAt   *time.Time `json:"lastFetchedAt"`
}

func Hash(value []byte) string {
	h := sha256.Sum256(value)
	return hex.EncodeToString(h[:])
}

func Open(dir, stationID string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "objects"), 0700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(filepath.Join(dir, "archive.db"), 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	s := &Store{db: db, dir: dir}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, name := range []string{"meta", "responses", "snapshots", "media", "species"} {
			if _, err := tx.CreateBucketIfNotExists([]byte(name)); err != nil {
				return err
			}
		}
		b := tx.Bucket([]byte("meta"))
		if existing := b.Get([]byte("station")); len(existing) > 0 && string(existing) != stationID {
			return errors.New("this archive belongs to a different station; use a separate data directory")
		}
		return b.Put([]byte("station"), []byte(stationID))
	})
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Ping(ctx context.Context) error {
	_, span := otel.Tracer("farts.archive").Start(ctx, "archive.ready")
	defer span.End()
	return s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket([]byte("meta")).Put([]byte("ready"), []byte("1")) })
}

func (s *Store) get(bucket, key string, target any) error {
	return s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket)).Get([]byte(key))
		if b == nil {
			return ErrNotFound
		}
		return json.Unmarshal(b, target)
	})
}

func (s *Store) Response(ctx context.Context, key string) (Entry, []byte, error) {
	_, span := otel.Tracer("farts.archive").Start(ctx, "archive.response.read")
	defer span.End()
	var entry Entry
	if err := s.get("responses", key, &entry); err != nil {
		return entry, nil, err
	}
	f, err := s.OpenObject(entry.Hash)
	if err != nil {
		return entry, nil, err
	}
	defer f.Close()
	body, err := io.ReadAll(io.LimitReader(f, 16<<20+1))
	if err != nil {
		return entry, nil, err
	}
	if int64(len(body)) != entry.Size || Hash(body) != entry.Hash {
		return entry, nil, errors.New("archive object integrity failure")
	}
	return entry, body, nil
}

func (s *Store) PutObject(reader io.Reader, limit int64) (Entry, error) {
	f, err := os.CreateTemp(filepath.Join(s.dir, "objects"), ".incoming-")
	if err != nil {
		return Entry{}, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(reader, limit+1))
	if err != nil {
		return Entry{}, err
	}
	if n > limit {
		return Entry{}, errors.New("upstream object exceeds size limit")
	}
	if err := f.Sync(); err != nil {
		return Entry{}, err
	}
	if err := f.Close(); err != nil {
		return Entry{}, err
	}
	hash := hex.EncodeToString(h.Sum(nil))
	destination := filepath.Join(s.dir, "objects", hash)
	if err := os.Rename(f.Name(), destination); err != nil {
		return Entry{}, err
	}
	dir, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return Entry{}, err
	}
	err = dir.Sync()
	_ = dir.Close()
	if err != nil {
		return Entry{}, err
	}
	return Entry{Hash: hash, Size: n, FetchedAt: time.Now().UTC()}, nil
}

func (s *Store) SaveResponse(ctx context.Context, key string, reader io.Reader) (Entry, error) {
	_, span := otel.Tracer("farts.archive").Start(ctx, "archive.response.write")
	defer span.End()
	entry, err := s.PutObject(reader, 16<<20)
	if err != nil {
		return Entry{}, err
	}
	value, err := json.Marshal(entry)
	if err != nil {
		return Entry{}, err
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		if err := tx.Bucket([]byte("responses")).Put([]byte(key), value); err != nil {
			return err
		}
		// Unchanged data shares one snapshot; refreshing a live view never deletes its earlier versions.
		snapshots := tx.Bucket([]byte("snapshots"))
		snapshotKey := []byte(key + "/" + entry.Hash)
		if snapshots.Get(snapshotKey) != nil {
			return nil
		}
		return snapshots.Put(snapshotKey, value)
	})
	return entry, err
}

func (s *Store) RegisterMedia(source, kind string) (string, error) {
	id := Hash([]byte(source))
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("media"))
		if b.Get([]byte(id)) != nil {
			return nil
		}
		value, err := json.Marshal(Media{ID: id, URL: source, Kind: kind})
		if err != nil {
			return err
		}
		return b.Put([]byte(id), value)
	})
	return id, err
}

func (s *Store) Media(id string) (Media, error) {
	var media Media
	if !hashPattern.MatchString(id) {
		return media, ErrNotFound
	}
	err := s.get("media", id, &media)
	return media, err
}

func (s *Store) SaveMedia(ctx context.Context, media Media, reader io.Reader, contentType string, limit int64) (Media, error) {
	_, span := otel.Tracer("farts.archive").Start(ctx, "archive.media.write")
	defer span.End()
	entry, err := s.PutObject(reader, limit)
	if err != nil {
		return media, err
	}
	media.Entry, media.ContentType = entry, contentType
	value, err := json.Marshal(media)
	if err != nil {
		return media, err
	}
	err = s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket([]byte("media")).Put([]byte(media.ID), value) })
	return media, err
}

func (s *Store) OpenObject(hash string) (*os.File, error) {
	if !hashPattern.MatchString(hash) {
		return nil, ErrNotFound
	}
	return os.Open(filepath.Join(s.dir, "objects", hash))
}

func (s *Store) AddSpecies(ids []string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("species"))
		for _, id := range ids {
			if err := b.Put([]byte(id), []byte{1}); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) HasSpecies(id string) bool {
	var found bool
	_ = s.db.View(func(tx *bolt.Tx) error { found = tx.Bucket([]byte("species")).Get([]byte(id)) != nil; return nil })
	return found
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	_, span := otel.Tracer("farts.archive").Start(ctx, "archive.stats")
	defer span.End()
	var stats Stats
	err := s.db.View(func(tx *bolt.Tx) error {
		stats.Responses = tx.Bucket([]byte("responses")).Stats().KeyN
		stats.Snapshots = tx.Bucket([]byte("snapshots")).Stats().KeyN
		stats.RegisteredMedia = tx.Bucket([]byte("media")).Stats().KeyN
		if err := tx.Bucket([]byte("snapshots")).ForEach(func(_, v []byte) error {
			var e Entry
			if err := json.Unmarshal(v, &e); err != nil {
				return err
			}
			if stats.FirstFetchedAt == nil || e.FetchedAt.Before(*stats.FirstFetchedAt) {
				t := e.FetchedAt
				stats.FirstFetchedAt = &t
			}
			if stats.LastFetchedAt == nil || e.FetchedAt.After(*stats.LastFetchedAt) {
				t := e.FetchedAt
				stats.LastFetchedAt = &t
			}
			return nil
		}); err != nil {
			return err
		}
		return tx.Bucket([]byte("media")).ForEach(func(_, v []byte) error {
			var media Media
			if err := json.Unmarshal(v, &media); err != nil {
				return fmt.Errorf("read media metadata: %w", err)
			}
			if media.Hash != "" {
				stats.MediaFiles++
				stats.MediaBytes += media.Size
			}
			return nil
		})
	})
	return stats, err
}
