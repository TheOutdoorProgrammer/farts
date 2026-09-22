import { CloudSun, Database, Radio, Thermometer, Wind } from 'lucide-react';
import { useEffect, useState } from 'react';
import { requestJson } from './api';
import { recordingDate, recordingTime } from './format';
import { SectionStatus } from './Dashboard';
import type { Dashboard, RuntimeConfig } from './types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function numeric(
  value: unknown,
  unit: string,
  convert: (value: number) => number = (value) => value,
) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(convert(value))}${unit}`
    : 'Not reported';
}
function timestamp(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? `${recordingDate(value)} at ${recordingTime(value)}`
    : 'Time not reported';
}

export function StationConditions({
  dashboard,
  config,
}: {
  dashboard: Dashboard;
  config: RuntimeConfig;
}) {
  const [archive, setArchive] = useState<Record<string, unknown> | null>(null);
  const [archiveError, setArchiveError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    requestJson('/api/archive', controller.signal)
      .then((value) => setArchive(record(value)))
      .catch(() => {
        if (!controller.signal.aborted) setArchiveError(true);
      });
    return () => controller.abort();
  }, []);
  const weatherSection = dashboard.sections.weather;
  const weather = record(weatherSection?.data?.weather);
  const pollution = record(weatherSection?.data?.airPollution);
  const sensorsSection = dashboard.sections.sensors;
  const environment = record(sensorsSection?.data?.environment);
  const system = record(sensorsSection?.data?.system);
  return (
    <section className="journal-section">
      <div className="section-intro">
        <p className="eyebrow">Out in the field</p>
        <h2>The station notebook.</h2>
        <p>
          Conditions around {config.stationName}, and the little recorder
          keeping watch.
        </p>
      </div>
      <div className="conditions-grid">
        <article className="condition-card">
          <h3>
            <CloudSun /> Weather nearby
          </h3>
          <SectionStatus section={weatherSection} />
          <p className="condition-caption">Regional weather from OpenWeather</p>
          <strong className="condition-number">
            {numeric(weather.temp, '°C', (value) => value - 273.15)}
          </strong>
          <dl>
            <div>
              <dt>Feels like</dt>
              <dd>
                {numeric(weather.feelsLike, '°C', (value) => value - 273.15)}
              </dd>
            </div>
            <div>
              <dt>Humidity</dt>
              <dd>{numeric(weather.humidity, '%')}</dd>
            </div>
            <div>
              <dt>
                <Wind size={15} /> Wind
              </dt>
              <dd>{numeric(weather.windSpeed, ' m/s')}</dd>
            </div>
            <div>
              <dt>Pressure</dt>
              <dd>{numeric(weather.pressure, ' hPa')}</dd>
            </div>
            <div>
              <dt>Regional air quality</dt>
              <dd>{numeric(pollution.aqi, ' / 5')}</dd>
            </div>
          </dl>
        </article>
        <article className="condition-card">
          <h3>
            <Thermometer /> At the microphone
          </h3>
          <SectionStatus section={sensorsSection} />
          <p className="condition-caption">
            Station sensor · {timestamp(environment.timestamp)}
          </p>
          <strong className="condition-number">
            {numeric(environment.temperature, '°C')}
          </strong>
          <dl>
            <div>
              <dt>Humidity</dt>
              <dd>{numeric(environment.humidity, '%')}</dd>
            </div>
            <div>
              <dt>Pressure</dt>
              <dd>{numeric(environment.barometricPressure, ' hPa')}</dd>
            </div>
            <div>
              <dt>Station air-quality index</dt>
              <dd>{numeric(environment.aqi, '')}</dd>
            </div>
            <div>
              <dt>Estimated CO₂</dt>
              <dd>{numeric(environment.eco2, ' ppm')}</dd>
            </div>
            <div>
              <dt>Sound level</dt>
              <dd>{numeric(environment.soundPressureLevel, ' dB')}</dd>
            </div>
          </dl>
        </article>
        <article className="condition-card">
          <h3>
            <Radio /> The listening post
          </h3>
          <p className="condition-caption">
            {config.stationName} · Station {config.stationId}
          </p>
          <dl>
            <div>
              <dt>Device</dt>
              <dd>{dashboard.station.type || 'Not reported'}</dd>
            </div>
            <div>
              <dt>Edition</dt>
              <dd>{dashboard.station.edition || 'Not reported'}</dd>
            </div>
            <div>
              <dt>Power source</dt>
              <dd>
                {typeof system.powerSource === 'string'
                  ? system.powerSource
                  : 'Not reported'}
              </dd>
            </div>
            <div>
              <dt>Battery</dt>
              <dd>{numeric(system.batteryVoltage, ' V')}</dd>
            </div>
            <div>
              <dt>Wi-Fi signal</dt>
              <dd>{numeric(system.wifiRssi, ' dBm')}</dd>
            </div>
            <div>
              <dt>Last sensor report</dt>
              <dd>{timestamp(system.timestamp)}</dd>
            </div>
          </dl>
        </article>
        <article className="condition-card archive-card">
          <h3>
            <Database /> Kept close to home.
          </h3>
          <p>
            Your field journal and downloaded recordings live in this station’s
            own archive.
          </p>
          {archive ? (
            <dl>
              <div>
                <dt>Saved recordings & images</dt>
                <dd>{numeric(archive.mediaFiles, '')}</dd>
              </div>
              <div>
                <dt>Media stored</dt>
                <dd>
                  {numeric(
                    archive.mediaBytes,
                    ' MB',
                    (value) => value / 1024 / 1024,
                  )}
                </dd>
              </div>
              <div>
                <dt>Saved data snapshots</dt>
                <dd>{numeric(archive.snapshots, '')}</dd>
              </div>
              <div>
                <dt>Latest archive update</dt>
                <dd>{timestamp(archive.lastFetchedAt)}</dd>
              </div>
            </dl>
          ) : (
            <p className="status-note">
              {archiveError
                ? 'Archive statistics are unavailable.'
                : 'Reading the archive…'}
            </p>
          )}
          <p className="section-footnote">
            Recordings are kept as they are collected. A quiet sensor is not
            proof that the station is offline.
          </p>
        </article>
      </div>
    </section>
  );
}
