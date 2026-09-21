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
}

export interface Feed {
  station: { id: string; name: string; timezone: string };
  recordings: Recording[];
  nextCursor: string | null;
  fetchedAt: string;
}

export type ListeningMode = 'natural' | 'bat';

export interface PreparedAudio {
  blob: Blob;
  duration: number;
  sourceDuration: number;
  sampleRate: number;
  waveform: number[];
}
