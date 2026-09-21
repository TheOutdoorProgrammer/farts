import type { Recording } from './types';

export function clock(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? Math.floor(seconds) : 0);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function recordingDate(
  timestamp: string,
  options: Intl.DateTimeFormatOptions = {},
) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
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
    window.location.origin,
  ).href;
}
