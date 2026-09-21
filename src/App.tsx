import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  AudioLines,
  Bird,
  CircleHelp,
  Headphones,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  Share2,
  X,
} from 'lucide-react';
import { fetchFeed, fetchRecording } from './api';
import { recordingDate, recordingLength, recordingTime } from './format';
import { MiniPlayer, PlayerCard } from './PlayerCard';
import { ShareDialog } from './ShareDialog';
import { reportError } from './telemetry';
import { usePlayer } from './usePlayer';
import type { Feed, Recording } from './types';

type Filter = 'all' | 'bird' | 'bat';

function RecordingRow({
  recording,
  index,
  active,
  playing,
  loading,
  onPlay,
  onShare,
}: {
  recording: Recording;
  index: number;
  active: boolean;
  playing: boolean;
  loading: boolean;
  onPlay: () => void;
  onShare: () => void;
}) {
  return (
    <li className={`recording-row${active ? ' active' : ''}`}>
      <span className="row-number" aria-hidden="true">
        {String(index + 1).padStart(2, '0')}
      </span>
      <button
        className="row-play"
        onClick={onPlay}
        disabled={!recording.audioUrl || loading}
        aria-label={`${playing ? 'Pause' : 'Play'} ${recording.commonName} recorded ${recordingDate(recording.timestamp)} at ${recordingTime(recording.timestamp)}`}
      >
        {recording.imageUrl ? (
          <img src={recording.imageUrl} alt="" loading="lazy" />
        ) : (
          <Bird size={23} />
        )}
        <span>
          {loading ? (
            <LoaderCircle className="spin" size={18} />
          ) : playing ? (
            <Pause size={18} fill="currentColor" />
          ) : (
            <Play size={18} fill="currentColor" />
          )}
        </span>
      </button>
      <div className="row-description">
        <button
          className="recording-title"
          onClick={onPlay}
          disabled={!recording.audioUrl || loading}
        >
          {recording.commonName}
          {active && playing && <AudioLines size={15} />}
        </button>
        <span>
          {recordingDate(recording.timestamp)} <b>·</b>{' '}
          {recordingTime(recording.timestamp)} ET <b>·</b>{' '}
          {recording.audioUrl
            ? recordingLength(recording)
            : 'No audio available'}
        </span>
      </div>
      <span className={`classification ${recording.classification}`}>
        {recording.classification === 'bat'
          ? 'Bat'
          : recording.classification === 'bird'
            ? 'Bird'
            : 'Wildlife'}
      </span>
      <span
        className="confidence"
        title="BirdWeather identification confidence"
      >
        {Math.round(recording.confidence * 100)}%<span>confidence</span>
      </span>
      <button
        className="row-share icon-button"
        onClick={onShare}
        aria-label={`Share ${recording.commonName} recorded at ${recordingTime(recording.timestamp)}`}
      >
        <Share2 size={18} />
      </button>
    </li>
  );
}

export function App() {
  const player = usePlayer();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [share, setShare] = useState<{
    recording: Recording;
    audio: boolean;
  } | null>(null);
  const [about, setAbout] = useState(false);
  const aboutRef = useRef<HTMLDialogElement>(null);
  const initialSelection = useRef(false);
  const userSelected = useRef(false);
  const moreRequest = useRef<AbortController | null>(null);
  const detailId = window.location.pathname.match(
    /^\/recordings\/(\d+)\/?$/,
  )?.[1];
  const invalidRoute = window.location.pathname !== '/' && !detailId;

  useEffect(() => {
    const controller = new AbortController();
    moreRequest.current?.abort();
    setLoading(true);
    setLoadingMore(false);
    setError('');
    setFeed(null);
    fetchFeed({ classification: filter, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setFeed(result);
        if (
          !initialSelection.current &&
          !detailId &&
          !invalidRoute &&
          result.recordings.length
        ) {
          initialSelection.current = true;
          player.select(
            result.recordings.find((item) => item.audioUrl) ||
              result.recordings[0],
          );
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(
          'BirdWeather is not responding right now. Try again in a moment.',
        );
        reportError('feed_load', 'network', err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filter, refresh, detailId, invalidRoute, player.select]);

  useEffect(() => {
    if (!detailId) return;
    const controller = new AbortController();
    fetchRecording(detailId, controller.signal)
      .then((recording) => {
        if (!controller.signal.aborted && !userSelected.current)
          player.select(recording);
      })
      .catch((err) => {
        if (controller.signal.aborted || userSelected.current) return;
        setDetailError(
          'This recording could not be opened. It may no longer be available on BirdWeather.',
        );
        reportError('feed_load', 'unavailable', err);
      });
    return () => controller.abort();
  }, [detailId, player.select]);

  useEffect(() => {
    document.title = player.recording
      ? `${player.recording.commonName} · Better Birds`
      : 'Better Birds · StoutBats recordings';
  }, [player.recording]);

  useEffect(() => {
    if (about) aboutRef.current?.showModal();
    else aboutRef.current?.close();
  }, [about]);

  useEffect(() => () => moreRequest.current?.abort(), []);

  const loadMore = async () => {
    if (!feed?.nextCursor || loadingMore) return;
    const cursor = feed.nextCursor;
    const controller = new AbortController();
    moreRequest.current?.abort();
    moreRequest.current = controller;
    setLoadingMore(true);
    setError('');
    try {
      const next = await fetchFeed({
        cursor,
        classification: filter,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setFeed((current) =>
        current
          ? {
              ...next,
              nextCursor: next.nextCursor === cursor ? null : next.nextCursor,
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
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        'Older recordings could not load. Your current recordings are still here.',
      );
      reportError('feed_load', 'network', err);
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };

  const showShare = (recording: Recording, audio = false) =>
    setShare({ recording, audio });
  const playRecording = (recording: Recording) => {
    userSelected.current = true;
    setDetailError('');
    if (player.recording?.id === recording.id && player.playing)
      player.toggle();
    else void player.listen(recording);
  };
  const recordings = (feed?.recordings || []).filter((recording) =>
    `${recording.commonName} ${recording.scientificName}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const species = new Set(
    feed?.recordings.map((recording) => recording.speciesId),
  ).size;

  return (
    <>
      <a className="skip-link" href="#recordings">
        Skip to recordings
      </a>
      <header className="site-header">
        <a href="/" className="wordmark" aria-label="Better Birds home">
          <span className="brand-icon">
            <AudioLines size={27} strokeWidth={2.4} />
          </span>
          better<span>birds</span>
          <span className="wordmark-period">.</span>
        </a>
        <div className="header-right">
          <span className="header-caption">
            Less scrolling. More listening.
          </span>
          <button
            className="icon-button about-button"
            onClick={() => setAbout(true)}
            aria-label="About Better Birds"
          >
            <CircleHelp size={21} />
          </button>
        </div>
      </header>
      <main className="site-main">
        <div className="station-heading">
          <div>
            {detailId ? (
              <a className="eyebrow back-link" href="/">
                <ArrowLeft size={14} /> All StoutBats recordings
              </a>
            ) : (
              <p className="eyebrow">
                <span className="station-mark" /> Station 30605 · BirdWeather
              </p>
            )}
            <h1>
              {detailId ? 'Shared recording' : 'StoutBats'}
              <span className="heading-dot">.</span>
            </h1>
            <p className="station-subtitle">
              {detailId
                ? 'A recording from StoutBats, shared with you.'
                : 'Birdsong by day. Bat calls after dark.'}
            </p>
          </div>
          <a
            className="source-link"
            href="https://app.birdweather.com/stations/30605"
            target="_blank"
            rel="noreferrer"
          >
            View station <ArrowUpRight size={17} />
          </a>
        </div>
        {(invalidRoute && !userSelected.current) || detailError ? (
          <section className="detail-error" role="alert">
            <h2>We couldn’t find that recording.</h2>
            <p>{detailError || 'This link does not point to a recording.'}</p>
            <a className="secondary-button" href="/">
              Browse StoutBats
            </a>
          </section>
        ) : (
          <PlayerCard player={player} onShare={showShare} />
        )}
        <section
          id="recordings"
          className="recordings-section"
          aria-labelledby="recordings-title"
        >
          <div className="recordings-heading">
            <div>
              <p className="eyebrow">The field log</p>
              <h2 id="recordings-title">
                Latest recordings
                <span className="count">{feed?.recordings.length ?? '…'}</span>
              </h2>
            </div>
            <button
              className="refresh-button"
              aria-label="Refresh recordings"
              onClick={() => setRefresh((value) => value + 1)}
              disabled={loading}
            >
              <RefreshCw size={17} className={loading ? 'spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
          <div className="feed-toolbar">
            <div
              className="filter-tabs"
              role="group"
              aria-label="Recording type"
            >
              {(['all', 'bird', 'bat'] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => {
                    setFilter(value);
                    setSearch('');
                  }}
                >
                  {value === 'all'
                    ? 'All recordings'
                    : value === 'bird'
                      ? 'Birds'
                      : 'Bats'}
                </button>
              ))}
            </div>
            <label className="search-field">
              <Search size={18} />
              <span className="sr-only">
                Find a species in loaded recordings
              </span>
              <input
                type="search"
                placeholder="Find a species"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          {loading ? (
            <div className="feed-loading" role="status">
              <LoaderCircle size={24} className="spin" />
              <p>Listening in on BirdWeather…</p>
            </div>
          ) : (
            <>
              {recordings.length > 0 && (
                <>
                  <div className="list-labels" aria-hidden="true">
                    <span>Recording</span>
                    <span>Type</span>
                    <span>Confidence</span>
                    <span>Share</span>
                  </div>
                  <ol className="recording-list">
                    {recordings.map((recording, index) => (
                      <RecordingRow
                        key={recording.id}
                        recording={recording}
                        index={index}
                        active={player.recording?.id === recording.id}
                        playing={
                          player.recording?.id === recording.id &&
                          player.playing
                        }
                        loading={
                          player.recording?.id === recording.id &&
                          player.loading
                        }
                        onPlay={() => playRecording(recording)}
                        onShare={() => showShare(recording)}
                      />
                    ))}
                  </ol>
                </>
              )}
              {!recordings.length && !error && (
                <div className="empty-state">
                  <Headphones size={32} />
                  <h3>
                    {search
                      ? 'No matches in these recordings.'
                      : 'A quiet patch.'}
                  </h3>
                  <p>
                    {search
                      ? 'Try a different species name, or load older recordings.'
                      : 'No recordings were returned for this filter. Try another one or check back later.'}
                  </p>
                  {search && (
                    <button
                      className="secondary-button"
                      onClick={() => setSearch('')}
                    >
                      Clear search
                    </button>
                  )}
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
                {search
                  ? `${recordings.length} matches in ${feed.recordings.length} loaded recordings`
                  : `${species} ${species === 1 ? 'species or groups' : 'species & groups'} in ${feed.recordings.length} recordings`}
                <small>
                  Times shown in Eastern Time. Identifications by BirdWeather.
                </small>
              </span>
              {feed.nextCursor && (
                <button
                  className="secondary-button load-more"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
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
        <footer className="site-footer">
          <a href="/" className="footer-brand">
            <AudioLines size={19} /> Better Birds
          </a>
          <p>
            Recordings & identifications from{' '}
            <a
              href="https://www.birdweather.com/"
              target="_blank"
              rel="noreferrer"
            >
              BirdWeather
            </a>
            .<br className="mobile-break" /> An independent listening companion.
          </p>
          <button onClick={() => setAbout(true)}>
            About & credits <ArrowUpRight size={14} />
          </button>
        </footer>
      </main>
      <audio
        ref={player.audioRef}
        {...player.audioEvents}
        preload="none"
        aria-label="Recording audio"
      />
      <MiniPlayer player={player} onShare={showShare} />
      {share && (
        <ShareDialog
          key={share.recording.id}
          recording={share.recording}
          audioTab={share.audio}
          onClose={() => setShare(null)}
          prepare={player.getPrepared}
        />
      )}
      <dialog
        ref={aboutRef}
        className="share-dialog about-dialog"
        onCancel={() => setAbout(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setAbout(false);
        }}
        aria-labelledby="about-title"
      >
        <div className="dialog-body">
          <button
            className="icon-button close-dialog"
            onClick={() => setAbout(false)}
            aria-label="Close about"
          >
            <X size={22} />
          </button>
          <AudioLines className="about-logo" size={35} />
          <h2 id="about-title">Closer to the sounds outside.</h2>
          <p>
            Better Birds is an independent player for recordings from StoutBats,
            station 30605 on BirdWeather.
          </p>
          <p>
            Recordings and automatic identifications come directly from
            BirdWeather. Confidence is the model’s estimate, and some bat calls
            can only be identified to a family or group.
          </p>
          <p>
            Bat listening slows the original recording 10× to bring ultrasonic
            calls into hearing range. Downloads use the same audible version.
            Natural sound keeps the original timing.
          </p>
          <p>
            Species photographs are reference images, not photos of the animals
            in these recordings. Photo credits appear on the selected recording.
          </p>
          <a
            className="secondary-button"
            href="https://app.birdweather.com/stations/30605"
            target="_blank"
            rel="noreferrer"
          >
            Visit StoutBats on BirdWeather <ArrowUpRight size={17} />
          </a>
        </div>
      </dialog>
    </>
  );
}
