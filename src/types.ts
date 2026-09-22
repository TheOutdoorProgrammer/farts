export type Classification = 'bird' | 'bat' | 'other';

export interface Recording {
  id: string;
  timestamp: string;
  commonName: string;
  scientificName: string;
  speciesId: string;
  classification: Classification;
  confidence: number;
  imageUrl: string | null;
  imageCredit: string | null;
  imageLicense: string | null;
  imageLicenseUrl: string | null;
  imageSource: string | null;
  behavior: string | null;
  audioUrl: string | null;
  startTime: number | null;
  endTime: number | null;
  duration?: number | null;
  sampleRate?: number | null;
  certainty?: string | null;
  algorithm?: string | null;
  probability?: number | null;
  score?: number | null;
  behaviorCode?: string | null;
  behaviorConfidence?: number | null;
  soundscapeId?: string | null;
  shortlist?: {
    speciesId: string;
    commonName: string;
    scientificName: string;
    weight: number;
  }[];
  raw?: unknown;
}

export interface Feed {
  station: { id: string; name: string; timezone: string };
  recordings: Recording[];
  nextCursor: string | null;
  fetchedAt: string;
  stale?: boolean;
}

export interface RuntimeConfig {
  name: string;
  stationId: string;
  stationName: string;
  stationDescription: string;
  timezone: string;
  version: string;
  faroUrl: string;
  publicUrl: string;
}

export interface Section<T> {
  data: T | null;
  fetchedAt: string | null;
  stale: boolean;
  error?: string;
}
export interface Species {
  id: string;
  commonName: string;
  scientificName: string;
  classification: string;
  imageUrl?: string | null;
  imageCredit?: string | null;
  imageLicense?: string | null;
  imageLicenseUrl?: string | null;
  imageSource?: string | null;
}
export interface SpeciesCount {
  speciesId: string;
  count: number;
  averageProbability?: number;
  breakdown?: {
    almostCertain: number;
    veryLikely: number;
    uncertain: number;
    unlikely: number;
  };
  species: Species;
}
export interface Dashboard {
  station: {
    id: string;
    name: string;
    timezone: string;
    type?: string;
    edition?: string;
  };
  sections: {
    counts: Section<{ detections: number; species: number; stations?: number }>;
    species: Section<SpeciesCount[]>;
    daily: Section<
      {
        date: string;
        dayOfYear: number;
        total: number;
        counts: SpeciesCount[];
      }[]
    >;
    timeOfDay: Section<
      {
        speciesId: string;
        count: number;
        species: Species;
        bins: { key: number | string; count: number }[];
      }[]
    >;
    weather: Section<Record<string, unknown>>;
    sensors: Section<Record<string, unknown>>;
  };
  fetchedAt: string;
  stale: boolean;
}
export interface Capability {
  id: string;
  label: string;
  description: string;
  path: string;
  method: 'GET';
  parameters: {
    name: string;
    label?: string;
    type: string;
    required?: boolean;
    default?: string | number | boolean;
    options?: string[];
  }[];
}
export interface Capabilities {
  operations: Capability[];
}

export type ListeningMode = 'natural' | 'bat' | 'realtime';

export interface Spectrogram {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
  maxFrequency: number;
  duration: number;
  minDecibels: number;
  maxDecibels: number;
}

export interface PreparedAudio {
  blob: Blob;
  duration: number;
  sourceDuration: number;
  sampleRate: number;
  listeningGainDb: number;
  waveform: number[];
  spectrogram: Spectrogram;
}
