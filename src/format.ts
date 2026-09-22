import type { Recording, RuntimeConfig } from './types';

let stationTimezone = 'UTC';
let publicOrigin = '';
export function configureFormat(config: RuntimeConfig) {
  stationTimezone = config.timezone;
  try {
    publicOrigin = config.publicUrl
      ? new URL(config.publicUrl).origin
      : window.location.origin;
  } catch {
    publicOrigin = window.location.origin;
  }
}
export function timezoneLabel() {
  return stationTimezone.replaceAll('_', ' ');
}

export function clock(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? Math.floor(seconds) : 0);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function recordingDate(
  timestamp: string,
  options: Intl.DateTimeFormatOptions = {},
) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: stationTimezone,
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(new Date(timestamp));
}

export function recordingTime(timestamp: string) {
  return recordingDate(timestamp, {
    month: undefined,
    day: undefined,
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function recordingLength(recording: Recording) {
  return recording.startTime !== null &&
    recording.endTime !== null &&
    recording.endTime > recording.startTime
    ? `${Math.round((recording.endTime - recording.startTime) * 10) / 10}s clip`
    : 'Full recording';
}

const certaintyLabels: Record<string, string> = {
  almost_certain: 'Almost certain',
  very_likely: 'Very likely',
  uncertain: 'Uncertain',
  unlikely: 'Unlikely',
};
export function certaintyLabel(certainty: string | null | undefined) {
  if (!certainty) return null;
  const words = certainty.replaceAll('_', ' ').trim();
  return (
    certaintyLabels[certainty] ??
    (words ? words[0].toUpperCase() + words.slice(1) : null)
  );
}

export function audioFilename(recording: Recording, bat: boolean) {
  const name = recording.commonName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${name || 'recording'}-${recording.timestamp.slice(0, 10)}${bat ? '-bat-listening' : ''}.wav`;
}

export function recordingLink(recording: Recording) {
  return new URL(
    `/recordings/${encodeURIComponent(recording.id)}`,
    publicOrigin || window.location.origin,
  ).href;
}
