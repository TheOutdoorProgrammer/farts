import { useEffect, useState } from 'react';
import {
  Bird,
  Download,
  Headphones,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  Share2,
  Volume2,
} from 'lucide-react';
import { certaintyLabel, clock, recordingDate, recordingTime } from './format';
import type { Player } from './usePlayer';
import type { ListeningMode, Recording } from './types';
import { Spectrogram } from './Spectrogram';
import { SeekOverlay } from './SeekOverlay';

const modeLabels: Record<ListeningMode, string> = {
  bat: 'Slowed 10×',
  realtime: 'Real time',
  natural: 'Original',
};
const modeNotes: Record<ListeningMode, string> = {
  bat: 'Slowed 10× so ultrasonic calls become audible.',
  realtime:
    'Regular speed. Frequencies divided by 10, the way a handheld bat detector works.',
  natural:
    'Original timing and pitch. Ultrasonic bat calls are outside human hearing.',
};

export function modePrefix(mode: ListeningMode) {
  return mode === 'natural' ? '' : `${modeLabels[mode]} · `;
}

export function PhotoCredit({ recording }: { recording: Recording }) {
  if (!recording.imageCredit) return null;
  return (
    <span className="photo-credit">
      Photo:{' '}
      {recording.imageSource ? (
        <a href={recording.imageSource} target="_blank" rel="noreferrer">
          {recording.imageCredit}
        </a>
      ) : (
        recording.imageCredit
      )}
      {recording.imageLicense && (
        <>
          {' '}
          ·{' '}
          {recording.imageLicenseUrl ? (
            <a
              href={recording.imageLicenseUrl}
              target="_blank"
              rel="noreferrer"
            >
              {recording.imageLicense}
            </a>
          ) : (
            recording.imageLicense
          )}
        </>
      )}
    </span>
  );
}

function percent(value: number | null | undefined) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : null;
}

export function RecordingFacts({ recording }: { recording: Recording }) {
  const facts: [string, string | null][] = [
    ['Certainty', certaintyLabel(recording.certainty)],
    ['Probability', percent(recording.probability)],
    [
      'Score',
      typeof recording.score === 'number' ? recording.score.toFixed(2) : null,
    ],
    [
      'Behavior',
      recording.behavior
        ? recording.behaviorConfidence !== null &&
          recording.behaviorConfidence !== undefined
          ? `${recording.behavior} (${percent(recording.behaviorConfidence)})`
          : recording.behavior
        : null,
    ],
    [
      'Sample rate',
      recording.sampleRate ? `${recording.sampleRate / 1000} kHz` : null,
    ],
    [
      'Soundscape',
      typeof recording.duration === 'number'
        ? `${recording.duration.toFixed(1)} s`
        : null,
    ],
    ['Model', recording.algorithm ?? null],
    ['Detection', recording.id],
  ];
  return (
    <dl className="recording-facts" aria-label="Recording details">
      {facts.map(
        ([label, value]) =>
          value && (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ),
      )}
    </dl>
  );
}

export function PlayerCard({
  player,
  onShare,
  elementRef,
}: {
  player: Player;
  onShare: (recording: Recording, audio?: boolean) => void;
  elementRef?: (element: HTMLElement | null) => void;
}) {
  const { recording, prepared, playing, loading, time } = player;
  const [visualization, setVisualization] = useState<
    'spectrogram' | 'waveform'
  >('spectrogram');
  if (!recording)
    return (
      <section
        className="player-card player-placeholder"
        aria-label="Recording player"
      >
        <Headphones size={40} />
        <h2>A good place to listen.</h2>
        <p>Choose a recording below to hear what’s out there.</p>
      </section>
    );
  const progress = prepared ? time / prepared.duration : 0;
  const bars = prepared?.waveform.length ?? 0;
  return (
    <section
      ref={elementRef}
      className="player-card"
      id={`recording-player-${recording.id}`}
      aria-label="Recording player"
    >
      <div className="player-content">
        <div className="eyebrow">
          <span
            className={playing ? 'sound-indicator playing' : 'sound-indicator'}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
            <i />
          </span>
          {loading
            ? 'Preparing your recording'
            : playing
              ? 'Now playing'
              : 'The listening room'}
        </div>
        <h2>{recording.commonName}</h2>
        <p className="scientific-name">{recording.scientificName}</p>
        <div className="recording-meta">
          <time dateTime={recording.timestamp}>
            {recordingDate(recording.timestamp)} ·{' '}
            {recordingTime(recording.timestamp)}
          </time>
          <span>
            {recording.classification === 'bat'
              ? 'Bat'
              : recording.classification === 'bird'
                ? 'Bird'
                : 'Wildlife'}
          </span>
          {recording.behavior && (
            <span className="behavior">{recording.behavior}</span>
          )}
        </div>
        {recording.classification === 'bat' && (
          <div
            className="listening-modes"
            role="group"
            aria-label="Bat listening mode"
          >
            {(
              [
                ['bat', Headphones],
                ['realtime', Radio],
                ['natural', Volume2],
              ] as const
            ).map(([value, Icon]) => (
              <button
                key={value}
                aria-pressed={player.mode === value}
                onClick={() => void player.listen(undefined, value)}
              >
                <Icon size={15} /> {modeLabels[value]}
              </button>
            ))}
          </div>
        )}
        <div className="player-actions">
          <button
            className="primary-button play-button"
            onClick={player.toggle}
            disabled={loading || !recording.audioUrl}
            aria-label={`${playing ? 'Pause' : 'Play'} ${recording.commonName}`}
          >
            {loading ? (
              <LoaderCircle className="spin" size={21} />
            ) : playing ? (
              <Pause size={21} fill="currentColor" />
            ) : (
              <Play size={21} fill="currentColor" />
            )}
            {loading ? 'Loading' : playing ? 'Pause' : 'Play recording'}
          </button>
          <button className="player-share" onClick={() => onShare(recording)}>
            <Share2 size={19} /> Share
          </button>
          <button
            className="icon-button download-button"
            onClick={() => onShare(recording, true)}
            aria-label="Download this recording"
          >
            <Download size={19} />
          </button>
        </div>
        <div
          className="visualization-controls"
          role="group"
          aria-label="Sound visualization"
        >
          <button
            aria-pressed={visualization === 'spectrogram'}
            onClick={() => setVisualization('spectrogram')}
          >
            Spectrogram
          </button>
          <button
            aria-pressed={visualization === 'waveform'}
            onClick={() => setVisualization('waveform')}
          >
            Waveform
          </button>
        </div>
        {visualization === 'spectrogram' ? (
          <Spectrogram
            data={prepared?.spectrogram}
            time={time}
            playbackDuration={prepared?.duration || 0}
            loading={loading}
            onSeek={player.seek}
          />
        ) : (
          <div className="waveform">
            {prepared ? (
              <>
                <svg
                  className="waveform-bars"
                  viewBox={`0 0 ${bars} 100`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {prepared.waveform.map((value, index) => {
                    const height = Math.max(4, value * 100);
                    return (
                      <rect
                        key={index}
                        x={index + 0.2}
                        width={0.6}
                        y={(100 - height) / 2}
                        height={height}
                        className={index / bars <= progress ? 'heard' : ''}
                      />
                    );
                  })}
                </svg>
                <SeekOverlay
                  time={time}
                  duration={prepared.duration}
                  label="Waveform position"
                  onSeek={player.seek}
                />
              </>
            ) : (
              <div
                className={
                  loading ? 'waveform-await loading' : 'waveform-await'
                }
              >
                <span />
                {loading
                  ? 'Bringing the outside in…'
                  : 'Press play to load the waveform'}
                <span />
              </div>
            )}
          </div>
        )}
        <div className="playback-time">
          <span>{clock(time)}</span>
          <span>{prepared ? 'Drag the playhead to explore' : ''}</span>
          <span>{prepared ? clock(prepared.duration) : '–:––'}</span>
        </div>
        {prepared && prepared.listeningGainDb >= 3 && (
          <p className="mode-note">
            Listening volume boosted. Original recording preserved.
          </p>
        )}
        {recording.classification === 'bat' && (
          <p className="mode-note">{modeNotes[player.mode]}</p>
        )}
        {player.notice && (
          <p className="player-notice" role="status">
            {player.notice}
          </p>
        )}
        {!recording.audioUrl && (
          <p className="player-notice">
            BirdWeather has no audio for this detection.
          </p>
        )}
        <details className="identification-details">
          <summary>
            {Math.round(recording.confidence * 100)}% identification confidence
          </summary>
          <p>
            Automatic identification, not a confirmed sighting. Similar calls
            may only be identifiable to a family or group.
          </p>
          {!!recording.shortlist?.length && (
            <ul>
              {recording.shortlist.slice(0, 5).map((candidate) => (
                <li key={candidate.speciesId}>
                  {candidate.commonName}{' '}
                  <span>{Math.round(candidate.weight * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
        </details>
        <RecordingFacts recording={recording} />
      </div>
      <div className="player-image">
        {recording.imageUrl ? (
          <img
            key={recording.imageUrl}
            src={recording.imageUrl}
            alt={recording.commonName}
            onError={(event) => {
              event.currentTarget.style.visibility = 'hidden';
            }}
          />
        ) : (
          <Bird className="image-fallback" size={90} strokeWidth={1} />
        )}
        <span className="photo-label">
          {recording.behavior || 'A moment in the wild'}
        </span>
        <PhotoCredit recording={recording} />
      </div>
      {recording.imageUrl && (
        <div className="mobile-photo-credit">
          <PhotoCredit recording={recording} />
        </div>
      )}
    </section>
  );
}

export function MiniPlayer({
  player,
  onShare,
  playerElement,
}: {
  player: Player;
  onShare: (recording: Recording) => void;
  playerElement: HTMLElement | null;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!playerElement) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(!entry.isIntersecting),
    );
    observer.observe(playerElement);
    return () => observer.disconnect();
  }, [playerElement]);
  if (!visible || !player.recording || (!player.prepared && !player.loading))
    return null;
  return (
    <aside className="mini-player" aria-label="Playback controls">
      <div className="mini-playing">
        <span
          className={
            player.playing ? 'sound-indicator playing' : 'sound-indicator'
          }
          aria-hidden="true"
        >
          <i />
          <i />
          <i />
          <i />
        </span>
        <div>
          <strong>{player.recording.commonName}</strong>
          <span>
            {modePrefix(player.mode)}
            {clock(player.time)} /{' '}
            {player.prepared ? clock(player.prepared.duration) : 'Loading'}
          </span>
        </div>
      </div>
      <button
        className="mini-play"
        onClick={player.toggle}
        disabled={player.loading}
        aria-label={player.playing ? 'Pause playback' : 'Resume playback'}
      >
        {player.loading ? (
          <LoaderCircle className="spin" size={22} />
        ) : player.playing ? (
          <Pause fill="currentColor" size={22} />
        ) : (
          <Play fill="currentColor" size={22} />
        )}
      </button>
      <button
        className="icon-button"
        onClick={() => onShare(player.recording!)}
        aria-label="Share playing recording"
      >
        <Share2 size={20} />
      </button>
    </aside>
  );
}
