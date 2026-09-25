import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareAudio } from './audio';
import { silentClip } from './audio/silence';
import { mediaErrorFailure, reportError } from './telemetry';
import type { ListeningMode, PreparedAudio, Recording } from './types';

type Source = 'none' | 'unlock' | 'prepared';

export function usePlayer(stationName = 'Wildlife station') {
  const audioRef = useRef<HTMLAudioElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const unlockUrl = useRef<string | null>(null);
  const unlocked = useRef(false);
  const sourceRef = useRef<Source>('none');
  const preparedRef = useRef<{ key: string; audio: PreparedAudio } | null>(
    null,
  );
  const activeRef = useRef<Recording | null>(null);
  const modeRef = useRef<ListeningMode>('natural');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [mode, setMode] = useState<ListeningMode>('natural');
  const [prepared, setPrepared] = useState<PreparedAudio | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [notice, setNotice] = useState('');

  const select = useCallback((next: Recording) => {
    if (activeRef.current?.id === next.id) return;
    requestRef.current?.abort();
    audioRef.current?.pause();
    audioRef.current?.removeAttribute('src');
    sourceRef.current = 'none';
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    preparedRef.current = null;
    activeRef.current = next;
    const nextMode = next.classification === 'bat' ? 'bat' : 'natural';
    modeRef.current = nextMode;
    setRecording(next);
    setMode(nextMode);
    setPrepared(null);
    setPlaying(false);
    setLoading(false);
    setTime(0);
    setNotice('');
  }, []);

  const unlock = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || unlocked.current) return;
    unlockUrl.current ??= URL.createObjectURL(silentClip);
    sourceRef.current = 'unlock';
    audio.src = unlockUrl.current;
    audio.play().then(
      () => {
        unlocked.current = true;
      },
      () => {},
    );
  }, []);

  const playNative = useCallback(async () => {
    try {
      await audioRef.current?.play();
      setNotice('');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        setNotice('Your recording is ready. Tap Play to listen.');
        return;
      }
      setNotice('Playback could not start. Tap Play to try again.');
      reportError('audio_play', 'playback', error);
    }
  }, []);

  const listen = useCallback(
    async (next?: Recording, nextMode?: ListeningMode) => {
      if (next && next.id !== activeRef.current?.id) select(next);
      const target = activeRef.current;
      if (!target) return;
      const targetMode = nextMode ?? modeRef.current;
      if (targetMode !== modeRef.current) {
        modeRef.current = targetMode;
        setMode(targetMode);
        audioRef.current?.pause();
      }
      const key = `${target.id}:${targetMode}`;
      if (preparedRef.current?.key === key) {
        requestRef.current?.abort();
        setLoading(false);
        setPrepared(preparedRef.current.audio);
        setTime(audioRef.current?.currentTime ?? 0);
        if (audioRef.current?.ended) audioRef.current.currentTime = 0;
        await playNative();
        return;
      }
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      unlock();
      setLoading(true);
      setNotice('');
      setPrepared(null);
      setTime(0);
      try {
        const result = await prepareAudio(
          target,
          targetMode,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(result.blob);
        preparedRef.current = { key, audio: result };
        setPrepared(result);
        const audio = audioRef.current;
        if (audio) {
          sourceRef.current = 'prepared';
          audio.src = objectUrl.current;
          audio.load();
          if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: target.commonName,
              artist: stationName,
              album:
                targetMode === 'bat'
                  ? 'FARTS · Slowed 10×'
                  : targetMode === 'realtime'
                    ? 'FARTS · Real time'
                    : 'FARTS',
            });
          }
          await playNative();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setNotice(
          'This recording could not load. Check your connection and try again.',
        );
        reportError('audio_load', 'decode', error);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [select, unlock, playNative, stationName],
  );

  const toggle = () => {
    if (playing) audioRef.current?.pause();
    else if (!loading) void listen();
  };

  const seek = (value: number) => {
    if (audioRef.current && prepared) {
      audioRef.current.currentTime = Math.min(
        prepared.duration,
        Math.max(0, value),
      );
      setTime(audioRef.current.currentTime);
    }
  };

  const getPrepared = (target: Recording, signal: AbortSignal) => {
    const targetMode = target.classification === 'bat' ? 'bat' : 'natural';
    const cached = preparedRef.current;
    return cached?.key === `${target.id}:${targetMode}`
      ? Promise.resolve(cached.audio)
      : prepareAudio(target, targetMode, signal);
  };

  useEffect(
    () => () => {
      requestRef.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      if (unlockUrl.current) URL.revokeObjectURL(unlockUrl.current);
    },
    [],
  );

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => {
      void playNative();
    });
    navigator.mediaSession.setActionHandler('pause', () =>
      audioRef.current?.pause(),
    );
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
    };
  }, [playNative]);

  const isPrepared = () => sourceRef.current === 'prepared';

  return {
    audioRef,
    recording,
    mode,
    prepared,
    playing,
    loading,
    time,
    notice,
    select,
    listen,
    toggle,
    seek,
    getPrepared,
    audioEvents: {
      onPlay: () => {
        if (isPrepared()) setPlaying(true);
      },
      onPause: () => {
        if (isPrepared()) setPlaying(false);
      },
      onEnded: () => {
        if (isPrepared()) setPlaying(false);
      },
      onTimeUpdate: () => {
        if (isPrepared()) setTime(audioRef.current?.currentTime ?? 0);
      },
      onError: () => {
        if (!isPrepared()) return;
        setPlaying(false);
        setNotice(
          'The audio player hit a problem. Reload the recording to try again.',
        );
        preparedRef.current = null;
        reportError(
          'audio_play',
          mediaErrorFailure(audioRef.current?.error?.code),
        );
      },
    },
  };
}

export type Player = ReturnType<typeof usePlayer>;
