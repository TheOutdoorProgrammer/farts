import { clock } from './format';

export function SeekOverlay({
  time,
  duration,
  label,
  valueText,
  onSeek,
}: {
  time: number;
  duration: number;
  label: string;
  valueText?: string;
  onSeek: (time: number) => void;
}) {
  const position = Math.max(0, Math.min(duration, time));
  const progress = duration > 0 ? position / duration : 0;
  return (
    <div className="seek-overlay">
      <span
        className="visualization-playhead"
        style={{ left: `${progress * 100}%` }}
        aria-hidden="true"
      />
      <input
        className="visualization-seek"
        type="range"
        min="0"
        max={duration || 1}
        step={duration > 0 ? duration / 1000 : 0.01}
        value={position}
        disabled={duration <= 0}
        aria-label={label}
        aria-valuetext={valueText || `${clock(position)} of ${clock(duration)}`}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
    </div>
  );
}
