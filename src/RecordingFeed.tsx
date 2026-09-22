import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  AudioLines,
  Bird,
  Headphones,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { fetchFeed } from './api';
import { PhotoCredit, PlayerCard } from './PlayerCard';
import {
  recordingDate,
  recordingLength,
  recordingTime,
  timezoneLabel,
} from './format';
import type { Feed, Recording } from './types';
import type { Player } from './usePlayer';
import type { readRoute } from './useRoute';

type Route = ReturnType<typeof readRoute>;
export function RecordingFeed({
  route,
  navigate,
  player,
  onShare,
  playerRef,
}: {
  route: Route;
  navigate: (changes: Partial<Route>, replace?: boolean) => void;
  player: Player;
  onShare: (recording: Recording, audio?: boolean) => void;
  playerRef?: (element: HTMLElement | null) => void;
}) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [advanced, setAdvanced] = useState(!!(route.from || route.to));
  const moreRequest = useRef<AbortController | null>(null);
  const { classification, query, speciesId, from, to } = route;

  useEffect(() => {
    const controller = new AbortController();
    moreRequest.current?.abort();
    setLoadingMore(false);
    setLoading(true);
    setError('');
    setFeed(null);
    const timer = setTimeout(
      () => {
        fetchFeed({
          classification,
          query,
          speciesId,
          from,
          to,
          signal: controller.signal,
        })
          .then((result) => {
            if (controller.signal.aborted) return;
            setFeed(result);
          })
          .catch((error) => {
            if (!controller.signal.aborted)
              setError(
                error instanceof Error
                  ? error.message
                  : 'Recordings could not load. Try again.',
              );
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 300 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [classification, query, speciesId, from, to, refresh]);
  useEffect(() => () => moreRequest.current?.abort(), []);

  const loadMore = async () => {
    if (!feed?.nextCursor || loadingMore) return;
    const cursor = feed.nextCursor;
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true);
    setError('');
    try {
      const next = await fetchFeed({
        cursor,
        classification,
        query,
        speciesId,
        from,
        to,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setFeed((current) =>
        current
          ? {
              ...next,
              recordings: [
                ...new Map(
                  [...current.recordings, ...next.recordings].map(
                    (recording) => [recording.id, recording],
                  ),
                ).values(),
              ],
            }
          : next,
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : 'Older recordings could not load.',
        );
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };
  const play = (recording: Recording) =>
    player.recording?.id === recording.id && player.playing
      ? player.toggle()
      : void player.listen(recording);
  return (
    <section
      id="recordings"
      className="recordings-section"
      aria-labelledby="recordings-title"
    >
      <div className="recordings-heading">
        <div>
          <p className="eyebrow">The field journal</p>
          <h2 id="recordings-title">Every call has a story.</h2>
        </div>
        <button
          className="refresh-button"
          aria-label="Refresh recordings"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={18} className={loading ? 'spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>
      <div className="feed-toolbar">
        <div className="filter-tabs" role="group" aria-label="Recording type">
          {(['all', 'bird', 'bat'] as const).map((value) => (
            <button
              key={value}
              aria-pressed={classification === value}
              onClick={() => navigate({ classification: value, speciesId: '' })}
            >
              {value === 'all'
                ? 'All wildlife'
                : value === 'bird'
                  ? 'Birds'
                  : 'Bats'}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={18} />
          <span className="sr-only">Search station recordings by species</span>
          <input
            type="search"
            placeholder="Find a species"
            value={query}
            onChange={(event) => navigate({ query: event.target.value }, true)}
          />
        </label>
        <button
          className="icon-button"
          aria-label="Filter recordings by date"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
        >
          <SlidersHorizontal size={18} />
        </button>
      </div>
      {advanced && (
        <div className="date-filters">
          <label>
            From
            <input
              type="date"
              value={from.slice(0, 10)}
              onChange={(event) => navigate({ from: event.target.value })}
            />
          </label>
          <label>
            Through
            <input
              type="date"
              value={to.slice(0, 10)}
              min={from.slice(0, 10)}
              onChange={(event) => navigate({ to: event.target.value })}
            />
          </label>
          <button
            className="text-button"
            onClick={() => navigate({ from: '', to: '' })}
          >
            Clear dates
          </button>
        </div>
      )}
      {speciesId && (
        <button
          className="filter-chip"
          onClick={() => navigate({ speciesId: '' })}
        >
          One species selected <X size={14} />
        </button>
      )}
      {feed?.stale && (
        <p className="status-note">
          Showing saved recordings while the station refreshes.
        </p>
      )}
      {loading ? (
        <div className="feed-loading" role="status">
          <LoaderCircle className="spin" size={26} />
          <p>Opening the field journal…</p>
        </div>
      ) : (
        <>
          {!!feed?.recordings.length && (
            <ol className="recording-list">
              {feed.recordings.map((recording, index) => {
                const active = player.recording?.id === recording.id;
                return (
                  <li className="recording-item" key={recording.id}>
                    <div className={`recording-row${active ? ' active' : ''}`}>
                      <span className="row-number" aria-hidden="true">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <button
                        className="row-play"
                        aria-expanded={active}
                        aria-controls={
                          active
                            ? `recording-player-${recording.id}`
                            : undefined
                        }
                        onClick={() => play(recording)}
                        disabled={
                          !recording.audioUrl || (active && player.loading)
                        }
                        aria-label={`${active && player.playing ? 'Pause' : 'Play'} ${recording.commonName} at ${recordingTime(recording.timestamp)}`}
                      >
                        {recording.imageUrl ? (
                          <img src={recording.imageUrl} alt="" loading="lazy" />
                        ) : (
                          <Bird size={24} />
                        )}
                        <span>
                          {active && player.loading ? (
                            <LoaderCircle className="spin" size={18} />
                          ) : active && player.playing ? (
                            <Pause size={18} fill="currentColor" />
                          ) : (
                            <Play size={18} fill="currentColor" />
                          )}
                        </span>
                      </button>
                      <div className="row-description">
                        <button
                          className="recording-title"
                          aria-expanded={active}
                          aria-controls={
                            active
                              ? `recording-player-${recording.id}`
                              : undefined
                          }
                          onClick={() => play(recording)}
                          disabled={
                            !recording.audioUrl || (active && player.loading)
                          }
                        >
                          {recording.commonName}
                          {active && player.playing && <AudioLines size={15} />}
                        </button>
                        <span>
                          {recordingDate(recording.timestamp)} <b>·</b>{' '}
                          {recordingTime(recording.timestamp)} <b>·</b>{' '}
                          {recording.audioUrl
                            ? recordingLength(recording)
                            : 'Audio unavailable'}
                        </span>
                        <a
                          className="recording-link"
                          href={`/recordings/${recording.id}`}
                        >
                          Open recording
                        </a>
                        {recording.imageUrl && (
                          <PhotoCredit recording={recording} />
                        )}
                      </div>
                      <span
                        className={`classification ${recording.classification}`}
                      >
                        {recording.classification === 'bat'
                          ? 'Bat'
                          : recording.classification === 'bird'
                            ? 'Bird'
                            : 'Wildlife'}
                      </span>
                      <span className="confidence">
                        {Math.round(recording.confidence * 100)}%
                        <span>confidence</span>
                      </span>
                      <button
                        className="row-share icon-button"
                        onClick={() => onShare(recording)}
                        aria-label={`Share ${recording.commonName} at ${recordingTime(recording.timestamp)}`}
                      >
                        <Share2 size={18} />
                      </button>
                    </div>
                    {active && (
                      <PlayerCard
                        player={player}
                        onShare={onShare}
                        elementRef={playerRef}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {!feed?.recordings.length && !error && (
            <div className="empty-state">
              <Headphones size={32} />
              <h3>A quiet patch.</h3>
              <p>
                No recordings match these filters. Try another species or date.
              </p>
              <button
                className="secondary-button"
                onClick={() =>
                  navigate({
                    query: '',
                    speciesId: '',
                    from: '',
                    to: '',
                    classification: 'all',
                  })
                }
              >
                Show all recordings
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <div className="feed-error" role="alert">
          <p>{error}</p>
          <button
            className="secondary-button"
            onClick={() =>
              feed?.nextCursor
                ? void loadMore()
                : setRefresh((value) => value + 1)
            }
          >
            Try again
          </button>
        </div>
      )}
      {feed && (
        <div className="feed-bottom">
          <span>
            {feed.recordings.length} recordings loaded
            <small>
              Times in {timezoneLabel()}. Automatic identifications by
              BirdWeather.
            </small>
          </span>
          {feed.nextCursor && (
            <button
              className="secondary-button load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ArrowDown size={17} />
              )}
              {loadingMore ? 'Loading…' : 'Older recordings'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
