import { useEffect, useId, useMemo, useRef } from 'react';
import type { Spectrogram as SpectrogramData } from './types';

const colors = [
  [7, 24, 26],
  [18, 73, 70],
  [59, 119, 99],
  [179, 169, 87],
  [245, 235, 164],
];

function seconds(value: number) {
  return `${value.toFixed(value < 10 ? 2 : 1)} s`;
}

export function Spectrogram({
  data,
  time,
  playbackDuration,
  loading,
  onSeek,
}: {
  data?: SpectrogramData;
  time: number;
  playbackDuration: number;
  loading: boolean;
  onSeek: (time: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const descriptionId = useId();
  const progress = playbackDuration
    ? Math.max(0, Math.min(1, time / playbackDuration))
    : 0;
  const colorRange = useMemo(() => {
    if (!data) return { maximumByte: 255, maximumDecibels: 0 };
    let peak = 0;
    for (const value of data.data) peak = Math.max(peak, value);
    const range = data.maxDecibels - data.minDecibels;
    const maximumDecibels = peak
      ? Math.min(
          data.maxDecibels,
          Math.ceil((data.minDecibels + (peak / 255) * range) / 5) * 5,
        )
      : data.maxDecibels;
    return {
      maximumByte: ((maximumDecibels - data.minDecibels) / range) * 255,
      maximumDecibels,
    };
  }, [data]);

  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !data) return;
    const pixels = context.createImageData(data.width, data.height);
    for (let x = 0; x < data.width; x++) {
      for (let y = 0; y < data.height; y++) {
        const level =
          Math.min(1, data.data[x * data.height + y] / colorRange.maximumByte) *
          (colors.length - 1);
        const lower = Math.min(colors.length - 2, Math.floor(level));
        const fraction = level - lower;
        const destination = ((data.height - 1 - y) * data.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          pixels.data[destination + channel] = Math.round(
            colors[lower][channel] * (1 - fraction) +
              colors[lower + 1][channel] * fraction,
          );
        }
        pixels.data[destination + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
  }, [data, colorRange]);

  if (!data)
    return (
      <div className="spectrogram-empty" role="status">
        <span>
          {loading
            ? 'Reading the shape of this call…'
            : 'Press play to see this call.'}
        </span>
        <small>Its frequencies, drawn over time.</small>
      </div>
    );

  const maximumKhz = data.maxFrequency / 1000;
  return (
    <figure className="spectrogram" aria-label="Recording spectrogram">
      <div className="spectrogram-heading">
        <span>
          Original frequency <b>kHz</b>
        </span>
        <span>{seconds(progress * data.duration)} recorded</span>
      </div>
      <div className="spectrogram-chart">
        <div className="spectrogram-frequency" aria-hidden="true">
          {[1, 0.75, 0.5, 0.25, 0].map((ratio) => (
            <span key={ratio}>{Number((ratio * maximumKhz).toFixed(1))}</span>
          ))}
        </div>
        <div className="spectrogram-plot">
          <canvas
            ref={canvas}
            width={data.width}
            height={data.height}
            role="img"
            aria-label={`Original recording frequencies from 0 to ${maximumKhz} kilohertz over ${seconds(data.duration)}. Brighter colors show stronger sound.`}
            aria-describedby={descriptionId}
          />
          <div className="spectrogram-grid" aria-hidden="true" />
          <span
            className="spectrogram-playhead"
            style={{ left: `${progress * 100}%` }}
            aria-hidden="true"
          />
          <input
            className="spectrogram-seek"
            type="range"
            min="0"
            max={playbackDuration}
            step={playbackDuration / 1000}
            value={time}
            aria-label="Spectrogram position"
            aria-valuetext={`${seconds(progress * data.duration)} into the original recording`}
            onChange={(event) => onSeek(Number(event.target.value))}
          />
        </div>
        <div className="spectrogram-time" aria-hidden="true">
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <span key={ratio}>{seconds(ratio * data.duration)}</span>
          ))}
        </div>
      </div>
      <figcaption id={descriptionId}>
        <span>
          Recorded time ·{' '}
          {playbackDuration / data.duration > 2
            ? 'Original ultrasonic frequencies, even when slowed.'
            : 'Original recording frequencies.'}
        </span>
        <span className="spectrogram-scale">
          <span>Auto contrast</span>
          <span>{data.minDecibels}</span>
          <i aria-hidden="true" />
          <span>{colorRange.maximumDecibels} dBFS</span>
        </span>
      </figcaption>
    </figure>
  );
}
