import { Bird, CalendarDays, Moon, Sun, TrendingUp } from 'lucide-react';
import { localMedia, safeLink } from './api';
import { recordingDate, recordingTime } from './format';
import type { Dashboard as DashboardData, Section, Species } from './types';

export const periodLabels = {
  day: 'Today',
  week: 'This week',
  month: 'This month',
  all: 'All time',
};
const number = (value: number) => new Intl.NumberFormat('en-US').format(value);

export function SectionStatus({ section }: { section?: Section<unknown> }) {
  if (!section || section.data === null)
    return (
      <p className="status-note">
        This part of the station report is unavailable. Try refreshing.
      </p>
    );
  return section.stale ? (
    <p className="status-note">
      Saved report
      {section.fetchedAt
        ? ` · ${recordingDate(section.fetchedAt)} at ${recordingTime(section.fetchedAt)}`
        : ''}
      . Waiting for the next update.
    </p>
  ) : null;
}

export function Stats({
  dashboard,
  period,
  loading,
}: {
  dashboard: DashboardData | null;
  period: string;
  loading: boolean;
}) {
  const counts = dashboard?.sections.counts;
  return (
    <div className="stats-strip" role="group" aria-label="Station statistics">
      <div>
        <span className="stat-icon">
          <AudioMark />
        </span>
        <strong>
          {counts?.data
            ? number(counts.data.detections)
            : loading
              ? '…'
              : 'N/A'}
        </strong>
        <span>
          calls detected{' '}
          <small className="stat-period-inline">
            {periodLabels[period as keyof typeof periodLabels]?.toLowerCase()}
          </small>
        </span>
      </div>
      <div>
        <Bird size={21} />
        <strong>
          {counts?.data ? number(counts.data.species) : loading ? '…' : 'N/A'}
        </strong>
        <span>species & groups</span>
      </div>
      <div className="stats-period">
        <CalendarDays size={19} />
        <span>
          {periodLabels[period as keyof typeof periodLabels]}
          <small>
            {counts?.stale
              ? 'Saved station totals'
              : counts?.data
                ? 'Station totals from BirdWeather'
                : 'Station totals unavailable'}
          </small>
        </span>
      </div>
    </div>
  );
}
function AudioMark() {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M3 8v5M7 4v13M11 7v7M15 2v17M19 8v5" />
    </svg>
  );
}

function SpeciesCredit({ species }: { species: Species }) {
  if (!species.imageCredit) return null;
  const source = safeLink(species.imageSource);
  const license = safeLink(species.imageLicenseUrl);
  return (
    <p className="species-credit">
      {source ? (
        <a href={source} target="_blank" rel="noreferrer">
          {species.imageCredit}
        </a>
      ) : (
        species.imageCredit
      )}
      {species.imageLicense && (
        <>
          {' '}
          ·{' '}
          {license ? (
            <a href={license} target="_blank" rel="noreferrer">
              {species.imageLicense}
            </a>
          ) : (
            species.imageLicense
          )}
        </>
      )}
    </p>
  );
}

export function SpeciesGallery({
  dashboard,
  onSpecies,
}: {
  dashboard: DashboardData;
  onSpecies: (id: string) => void;
}) {
  const section = dashboard.sections.species;
  const entries = section?.data || [];
  return (
    <section className="journal-section" aria-labelledby="species-heading">
      <div className="section-intro">
        <p className="eyebrow">Meet the neighbors</p>
        <h2 id="species-heading">The local cast.</h2>
        <p>
          Familiar voices and new arrivals. Open a species to hear its
          recordings.
        </p>
      </div>
      <SectionStatus section={section} />
      {!entries.length && section?.data && (
        <div className="empty-state">
          <Bird size={32} />
          <h3>No visitors in this report.</h3>
          <p>Try a wider date range or another wildlife filter.</p>
        </div>
      )}
      <div className="species-grid">
        {entries.map((entry) => {
          const species = entry.species;
          const photo =
            species.imageCredit && species.imageLicense
              ? localMedia(species.imageUrl)
              : null;
          return (
            <article className="species-card" key={entry.speciesId}>
              <button
                className="species-open"
                onClick={() => onSpecies(entry.speciesId)}
              >
                <div
                  className={`species-portrait ${species.classification === 'bat' ? 'night' : ''}`}
                >
                  {photo ? (
                    <img src={photo} alt="" loading="lazy" />
                  ) : species.classification === 'bat' ? (
                    <Moon size={46} strokeWidth={1} />
                  ) : (
                    <Bird size={46} strokeWidth={1} />
                  )}
                  <span>
                    {species.classification === 'bat'
                      ? 'After dark'
                      : 'Day & dawn'}
                  </span>
                </div>
                <div className="species-description">
                  <h3>{species.commonName}</h3>
                  <p>{species.scientificName}</p>
                  <strong>
                    {number(entry.count)}{' '}
                    {entry.count === 1 ? 'detection' : 'detections'}
                  </strong>
                </div>
              </button>
              {photo && <SpeciesCredit species={species} />}
              {typeof entry.averageProbability === 'number' && (
                <p className="species-confidence">
                  {Math.round(entry.averageProbability * 100)}% average model
                  confidence
                </p>
              )}
            </article>
          );
        })}
      </div>
      <p className="section-footnote">
        Reference photographs. Automatic identifications may describe a species,
        family, or group, and are not confirmed sightings.
      </p>
    </section>
  );
}

export function Activity({ dashboard }: { dashboard: DashboardData }) {
  const daily = dashboard.sections.daily;
  const hours = dashboard.sections.timeOfDay;
  const days = [...(daily?.data || [])].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const bucketSize = Math.max(1, Math.ceil(days.length / 40));
  const chartDays = Array.from(
    { length: Math.ceil(days.length / bucketSize) },
    (_, index) => {
      const bucket = days.slice(index * bucketSize, (index + 1) * bucketSize);
      return {
        ...bucket[0],
        total: bucket.reduce((sum, day) => sum + day.total, 0),
        endDate: bucket[bucket.length - 1].date,
      };
    },
  );
  const max = Math.max(1, ...chartDays.map((day) => day.total));
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    birds: 0,
    bats: 0,
    other: 0,
  }));
  for (const item of hours?.data || [])
    for (const bin of item.bins || []) {
      const hour = Math.floor(Number(String(bin.key).split(':')[0]));
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const key =
        item.species.classification === 'bat'
          ? 'bats'
          : item.species.classification === 'avian' ||
              item.species.classification === 'bird'
            ? 'birds'
            : 'other';
      hourly[hour][key] += bin.count;
    }
  const maxHour = Math.max(
    1,
    ...hourly.map((hour) => hour.birds + hour.bats + hour.other),
  );
  return (
    <section className="journal-section">
      <div className="section-intro">
        <p className="eyebrow">Life has a rhythm</p>
        <h2>Around the clock.</h2>
        <p>
          The morning chorus. The night shift. Find the hours when the yard
          comes alive.
        </p>
      </div>
      <div className="activity-panel night-panel">
        <div className="panel-heading">
          <h3>
            <Sun size={21} /> Day into night <Moon size={19} />
          </h3>
          <span>Reported hourly activity</span>
        </div>
        <SectionStatus section={hours} />
        <p className="hour-scope-note">
          BirdWeather reports these hourly counts separately. They may not match
          the selected period’s totals.
        </p>
        {hours?.data && (
          <>
            <div
              className="hour-chart"
              role="img"
              aria-label={`Hourly detections: ${hourly.map((hour) => `${hour.hour}:00, ${hour.birds} bird and ${hour.bats} bat calls`).join('; ')}`}
            >
              {hourly.map((hour) => (
                <div
                  className="hour-column"
                  key={hour.hour}
                  title={`${String(hour.hour).padStart(2, '0')}:00 · ${number(hour.birds)} bird, ${number(hour.bats)} bat calls`}
                >
                  <div className="hour-stack">
                    <i
                      className="bird-bar"
                      style={{ height: `${(hour.birds / maxHour) * 100}%` }}
                    />
                    <i
                      className="bat-bar"
                      style={{ height: `${(hour.bats / maxHour) * 100}%` }}
                    />
                    <i
                      className="other-bar"
                      style={{ height: `${(hour.other / maxHour) * 100}%` }}
                    />
                  </div>
                  {hour.hour % 6 === 0 && (
                    <span>
                      {hour.hour === 0
                        ? '12am'
                        : hour.hour === 12
                          ? '12pm'
                          : hour.hour < 12
                            ? `${hour.hour}am`
                            : `${hour.hour - 12}pm`}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="chart-legend">
              <span>
                <i className="bird-bar" /> Birds
              </span>
              <span>
                <i className="bat-bar" /> Bats
              </span>
              <span>
                <i className="other-bar" /> Other wildlife
              </span>
            </div>
          </>
        )}
      </div>
      <div className="activity-panel">
        <div className="panel-heading">
          <h3>
            <TrendingUp size={21} /> The daily chorus
          </h3>
          <span>Detections per day</span>
        </div>
        <SectionStatus section={daily} />
        {!!days.length && (
          <div
            className="daily-chart"
            role="img"
            aria-label={chartDays
              .map(
                (day) =>
                  `${day.date} to ${day.endDate}: ${day.total} detections`,
              )
              .join('; ')}
          >
            {chartDays.map((day, index) => (
              <div className="day-column" key={`${day.date}-${index}`}>
                <div
                  title={`${day.date}${day.endDate !== day.date ? ` to ${day.endDate}` : ''}: ${number(day.total)} detections`}
                  style={{
                    height: `${Math.max(day.total ? 1 : 0, (day.total / max) * 100)}%`,
                  }}
                />
                {(chartDays.length < 12 ||
                  index % Math.ceil(chartDays.length / 7) === 0) && (
                  <span>{day.date?.slice(5) || `Day ${day.dayOfYear}`}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {bucketSize > 1 && (
          <p className="section-footnote">
            Each bar combines up to {bucketSize} days. The table below retains
            daily totals.
          </p>
        )}
        {!days.length && daily?.data && (
          <p className="status-note">
            No daily activity was returned for this period.
          </p>
        )}
      </div>
      <details className="data-table-details">
        <summary>Read the activity numbers</summary>
        <div className="table-scroll">
          <table>
            <caption>Reported hourly activity</caption>
            <thead>
              <tr>
                <th scope="col">Hour</th>
                <th scope="col">Birds</th>
                <th scope="col">Bats</th>
                <th scope="col">Other</th>
              </tr>
            </thead>
            <tbody>
              {hourly.map((hour) => (
                <tr key={hour.hour}>
                  <th scope="row">{String(hour.hour).padStart(2, '0')}:00</th>
                  <td>{number(hour.birds)}</td>
                  <td>{number(hour.bats)}</td>
                  <td>{number(hour.other)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table>
            <caption>Daily station detections</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Detections</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day, index) => (
                <tr key={`${day.date}-${index}`}>
                  <th scope="row">{day.date}</th>
                  <td>{number(day.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
