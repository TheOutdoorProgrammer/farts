import { useEffect, useState } from 'react';
import {
  Bird,
  Download,
  Headphones,
  LoaderCircle,
  Pause,
  Play,
  Share2,
  Volume2,
} from 'lucide-react';
import { clock, recordingDate, recordingTime } from './format';
import type { Player } from './usePlayer';
import type { Recording } from './types';

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

export function PlayerCard({
  player,
  onShare,
}: {
  player: Player;
  onShare: (recording: Recording, audio?: boolean) => void;
}) {
  const { recording, prepared, playing, loading, time } = player;
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
  return (
    <section className="player-card" aria-label="Recording player">
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
            {recordingTime(recording.timestamp)} ET
          </time>
          <span>
            {recording.classification === 'bat'
              ? 'Bat'
              : recording.classification === 'bird'
                ? 'Bird'
                : 'Wildlife'}
          </span>
        </div>
        {recording.classification === 'bat' && (
          <div
            className="listening-modes"
            role="group"
            aria-label="Bat listening mode"
          >
            <button
              aria-pressed={player.mode === 'bat'}
              onClick={() => void player.listen(undefined, 'bat')}
            >
              <Headphones size={15} /> Bat listening
            </button>
            <button
              aria-pressed={player.mode === 'natural'}
              onClick={() => void player.listen(undefined, 'natural')}
            >
              <Volume2 size={15} /> Natural sound
            </button>
          </div>
        )}
        <div className="waveform" aria-hidden="true">
          {prepared ? (
            prepared.waveform.map((value, index) => (
              <span
                key={index}
                className={
                  index / prepared.waveform.length <= progress ? 'heard' : ''
                }
                style={{ height: `${Math.max(5, value * 100)}%` }}
              />
            ))
          ) : (
            <div
              className={loading ? 'waveform-await loading' : 'waveform-await'}
            >
              <span />
              {loading
                ? 'Bringing the outside in…'
                : 'Press play to load the waveform'}
              <span />
            </div>
          )}
        </div>
        <div className="scrubber-row">
          <span>{clock(time)}</span>
          <input
            aria-label="Recording position"
            type="range"
            min="0"
            max={prepared?.duration || 1}
            step="0.01"
            value={time}
            disabled={!prepared}
            onChange={(event) => player.seek(Number(event.target.value))}
          />
          <span>{prepared ? clock(prepared.duration) : '–:––'}</span>
        </div>
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
        {recording.classification === 'bat' && (
          <p className="mode-note">
            {player.mode === 'bat'
              ? 'Slowed 10× so ultrasonic calls become audible.'
              : 'Original timing. Ultrasonic bat calls are outside human hearing.'}
          </p>
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
}: {
  player: Player;
  onShare: (recording: Recording) => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const card = document.querySelector('.player-card');
    if (!card) return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(!entry.isIntersecting),
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [player.recording?.id]);
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
            {player.mode === 'bat' ? 'Bat listening · ' : ''}
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
