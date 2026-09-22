import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Bird,
  BookOpen,
  Check,
  CircleHelp,
  Code,
  LoaderCircle,
  Radio,
  RefreshCw,
  Share2,
  TrendingUp,
  X,
} from 'lucide-react';
import { fetchConfig, fetchDashboard, fetchRecording } from './api';
import { Activity, periodLabels, SpeciesGallery, Stats } from './Dashboard';
import { DataExplorer } from './DataExplorer';
import { configureFormat, timezoneLabel } from './format';
import { MiniPlayer, PlayerCard } from './PlayerCard';
import { RecordingFeed } from './RecordingFeed';
import { ShareDialog } from './ShareDialog';
import { StationConditions } from './StationConditions';
import { initializeTelemetry, reportError } from './telemetry';
import { usePlayer } from './usePlayer';
import { useRoute, type Period, type View } from './useRoute';
import { useVersionWatch } from './useVersionWatch';
import type { Dashboard, Recording, RuntimeConfig } from './types';

const views = [
  { id: 'journal', label: 'Field journal', icon: BookOpen },
  { id: 'species', label: 'Species', icon: Bird },
  { id: 'activity', label: 'Activity', icon: TrendingUp },
  { id: 'station', label: 'The station', icon: Radio },
  { id: 'data', label: 'Explore data', icon: Code },
] as const;

function Brand() {
  return (
    <a href="/" className="wordmark" aria-label="FARTS home">
      <img src="/favicon.svg" alt="" width="43" height="43" />
      <span className="brand-letters">
        FARTS<span className="wordmark-period">.</span>
      </span>
      <span className="brand-expansion">
        Flying Animal Recon
        <br />
        and Telemetry Service
      </span>
    </a>
  );
}

export function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetchConfig(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          configureFormat(value);
          initializeTelemetry(value);
          setConfig(value);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : 'The station could not open.',
          );
      });
    return () => controller.abort();
  }, [attempt]);
  if (!config)
    return (
      <>
        <header className="site-header">
          <Brand />
        </header>
        <main className="startup-state">
          {error ? (
            <>
              <h1>The station is taking a breather.</h1>
              <p role="alert">{error}</p>
              <button
                className="secondary-button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw size={18} /> Try again
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="spin" size={30} />
              <h1>A little closer to the wild.</h1>
              <p role="status">Opening your station…</p>
            </>
          )}
        </main>
      </>
    );
  return <StationApp config={config} />;
}

function StationApp({ config }: { config: RuntimeConfig }) {
  const { route, navigate } = useRoute();
  const player = usePlayer(config.stationName);
  const updateAvailable = useVersionWatch(
    config.version,
    player.playing || player.loading,
  );
  const [playerElement, setPlayerElement] = useState<HTMLElement | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [detailError, setDetailError] = useState('');
  const [share, setShare] = useState<{
    recording: Recording;
    audio: boolean;
  } | null>(null);
  const [about, setAbout] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareNotice, setShareNotice] = useState('');
  const aboutRef = useRef<HTMLDialogElement>(null);
  const { period, classification, detailId, view } = route;

  useEffect(() => {
    if (detailId) {
      setDashboardLoading(false);
      return;
    }
    const controller = new AbortController();
    setDashboardLoading(true);
    setDashboardError('');
    setDashboard(null);
    fetchDashboard(period, classification, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDashboard(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setDashboardError(
            error instanceof Error
              ? error.message
              : 'The station report could not load.',
          );
          reportError('feed_load', 'network', error);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDashboardLoading(false);
      });
    return () => controller.abort();
  }, [period, classification, refresh, detailId]);
  useEffect(() => {
    if (!detailId) {
      setDetailError('');
      return;
    }
    const controller = new AbortController();
    setDetailError('');
    fetchRecording(detailId, controller.signal)
      .then((recording) => {
        if (!controller.signal.aborted) player.select(recording);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setDetailError(
            error instanceof Error
              ? error.message
              : 'This recording could not open.',
          );
      });
    return () => controller.abort();
  }, [detailId, player.select]);
  useEffect(() => {
    document.title =
      detailId && player.recording
        ? `${player.recording.commonName} · ${config.stationName} · FARTS`
        : `${config.stationName} · FARTS`;
  }, [detailId, player.recording, config.stationName]);
  useEffect(() => {
    if (about) aboutRef.current?.showModal();
    else aboutRef.current?.close();
  }, [about]);
  const showShare = (recording: Recording, audio = false) =>
    setShare({ recording, audio });
  const shareView = async () => {
    const url = new URL(
      window.location.pathname + window.location.search,
      config.publicUrl || window.location.origin,
    ).href;
    try {
      if (navigator.share)
        await navigator.share({ title: `${config.stationName} · FARTS`, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setShareNotice('Link copied. These filters travel with it.');
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError'))
        setShareNotice(`Copy this view’s link: ${url}`);
    }
  };
  const changeView = (next: View) => {
    navigate({ view: next, detailId: '', invalid: false });
    setShareNotice('');
    setCopied(false);
  };

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to field journal
      </a>
      <header className="site-header">
        <Brand />
        <div className="header-right">
          <span className="header-caption">
            Good calls. Questionable acronym.
          </span>
          <button
            className="icon-button about-button"
            onClick={() => setAbout(true)}
            aria-label="About FARTS"
          >
            <CircleHelp size={21} />
          </button>
        </div>
      </header>
      <main className="site-main" id="main-content">
        <div className="station-heading">
          <div>
            {detailId ? (
              <button
                className="eyebrow back-link text-button"
                onClick={() => changeView('journal')}
              >
                <ArrowLeft size={14} /> Back to {config.stationName}
              </button>
            ) : (
              <p className="eyebrow">
                <span className="station-mark" /> Your window into the wild ·
                Station {config.stationId}
              </p>
            )}
            <h1>
              {detailId ? 'Listen to this' : config.stationName}
              <span className="heading-dot">.</span>
            </h1>
            <p className="station-subtitle">
              {detailId
                ? `A recording from ${config.stationName}, shared with you.`
                : config.stationDescription ||
                  'Birdsong by day. Bat calls after dark. A family field journal.'}
            </p>
          </div>
          <button
            className="secondary-button share-view"
            onClick={() => void shareView()}
          >
            {copied ? <Check size={17} /> : <Share2 size={17} />}
            {copied ? 'Copied' : 'Share this view'}
          </button>
        </div>
        {shareNotice && (
          <p className="share-view-notice" role="status">
            {shareNotice}
          </p>
        )}
        {updateAvailable && (
          <p className="status-note update-note" role="status">
            A newer FARTS is live.{' '}
            <button
              className="text-button"
              onClick={() => window.location.reload()}
            >
              Reload when you’re ready
            </button>
          </p>
        )}
        <nav className="section-nav" aria-label="Station sections">
          {views.map((item) => (
            <button
              key={item.id}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => changeView(item.id)}
            >
              <item.icon size={17} />
              {item.label}
            </button>
          ))}
        </nav>
        {view !== 'data' && view !== 'journal' && (
          <div className="report-controls">
            <div
              className="period-picker"
              role="group"
              aria-label="Report period"
            >
              {(Object.keys(periodLabels) as Period[]).map((value) => (
                <button
                  key={value}
                  aria-pressed={period === value}
                  onClick={() => navigate({ period: value })}
                >
                  {periodLabels[value]}
                </button>
              ))}
            </div>
            <label className="classification-select">
              <span className="sr-only">Wildlife type</span>
              <select
                value={classification}
                onChange={(event) =>
                  navigate({
                    classification: event.target.value as typeof classification,
                  })
                }
              >
                <option value="all">All wildlife</option>
                <option value="bird">Birds</option>
                <option value="bat">Bats</option>
              </select>
            </label>
            <button
              className="icon-button report-refresh"
              onClick={() => setRefresh((value) => value + 1)}
              disabled={dashboardLoading}
              aria-label="Refresh station report"
            >
              <RefreshCw size={17} className={dashboardLoading ? 'spin' : ''} />
            </button>
          </div>
        )}
        {view !== 'data' && !detailId && (
          <Stats
            dashboard={dashboard}
            period={period}
            loading={dashboardLoading}
          />
        )}
        {dashboard?.stale && !detailId && (
          <p className="status-note">
            Some sections show saved reports while new data is unavailable.
          </p>
        )}
        {dashboardError && view !== 'data' && !detailId && (
          <div className="feed-error" role="alert">
            <p>{dashboardError}</p>
            <button
              className="secondary-button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        )}
        {view === 'journal' && (
          <>
            {route.invalid || detailError ? (
              <section className="detail-error" role="alert">
                <h2>This recording is out of reach.</h2>
                <p>
                  {detailError || 'This link does not point to a recording.'}
                </p>
                <button
                  className="secondary-button"
                  onClick={() => changeView('journal')}
                >
                  Browse recordings
                </button>
              </section>
            ) : detailId ? (
              <PlayerCard
                player={player}
                onShare={showShare}
                elementRef={setPlayerElement}
              />
            ) : null}
            {!detailId && (
              <RecordingFeed
                route={route}
                navigate={navigate}
                player={player}
                onShare={showShare}
                playerRef={setPlayerElement}
              />
            )}
          </>
        )}
        {view !== 'journal' && view !== 'data' && dashboardLoading && (
          <div className="feed-loading" role="status">
            <LoaderCircle className="spin" size={25} />
            <p>Reading the station notebook…</p>
          </div>
        )}
        {view === 'species' && dashboard && (
          <SpeciesGallery
            dashboard={dashboard}
            onSpecies={(speciesId) =>
              navigate({ view: 'journal', speciesId, detailId: '', query: '' })
            }
          />
        )}
        {view === 'activity' && dashboard && <Activity dashboard={dashboard} />}
        {view === 'station' && dashboard && (
          <StationConditions dashboard={dashboard} config={config} />
        )}
        {view === 'data' && <DataExplorer />}
        <footer className="site-footer">
          <a href="/" className="footer-brand">
            <img src="/favicon.svg" alt="" width="25" height="25" /> FARTS
          </a>
          <p>
            Serious about the wildlife.
            <br />A family field journal, powered by{' '}
            <a
              href="https://www.birdweather.com/"
              target="_blank"
              rel="noreferrer"
            >
              BirdWeather
            </a>
            . Times in {timezoneLabel()}.
          </p>
          <button onClick={() => setAbout(true)}>
            About &amp; credits <ArrowUpRight size={14} />
          </button>
        </footer>
      </main>
      <audio
        ref={player.audioRef}
        {...player.audioEvents}
        preload="none"
        aria-label="Recording audio"
      />
      <MiniPlayer
        player={player}
        onShare={showShare}
        playerElement={playerElement}
      />
      {share && (
        <ShareDialog
          key={share.recording.id}
          recording={share.recording}
          audioTab={share.audio}
          stationName={config.stationName}
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
          <img
            className="about-logo"
            src="/favicon.svg"
            alt=""
            width="52"
            height="52"
          />
          <p className="eyebrow">Yes, we know.</p>
          <h2 id="about-title">FARTS. For the family.</h2>
          <p>
            <strong>Flying Animal Recon and Telemetry Service.</strong> A home
            for the birds, bats, and recordings from {config.stationName}.
          </p>
          <p>
            Recordings and automatic identifications come from BirdWeather.
            Confidence is the model’s estimate. Some calls can only be
            identified to a family or group.
          </p>
          <p>
            Bat listening slows the original recording 10× to make ultrasonic
            calls audible. Downloads use that same audible version. Natural
            sound keeps the original timing.
          </p>
          <p>
            Species photographs are reference images. Credits and licenses
            appear beside each photograph.
          </p>
          <p>
            Your station keeps its own archive. No BirdWeather account is needed
            to listen to a shared recording here.
          </p>
          <a
            className="secondary-button"
            href={`https://app.birdweather.com/stations/${encodeURIComponent(config.stationId)}`}
            target="_blank"
            rel="noreferrer"
          >
            Original BirdWeather station <ArrowUpRight size={17} />
          </a>
        </div>
      </dialog>
    </>
  );
}
