import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileAudio,
  Link,
  LoaderCircle,
  Share2,
  X,
} from 'lucide-react';
import {
  audioFilename,
  clock,
  recordingDate,
  recordingLink,
  recordingTime,
} from './format';
import { reportError } from './telemetry';
import type { PreparedAudio, Recording } from './types';

export function ShareDialog({
  recording,
  audioTab,
  onClose,
  prepare,
}: {
  recording: Recording;
  audioTab: boolean;
  onClose: () => void;
  prepare: (
    recording: Recording,
    signal: AbortSignal,
  ) => Promise<PreparedAudio>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  const [tab, setTab] = useState<'link' | 'audio'>(audioTab ? 'audio' : 'link');
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const url = recordingLink(recording);

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (tab !== 'audio' || file) return;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    setNotice('');
    prepareRef
      .current(recording, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setFile(
          new File(
            [result.blob],
            audioFilename(recording, recording.classification === 'bat'),
            { type: 'audio/wav' },
          ),
        );
        setDuration(result.duration);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setFailed(true);
        setNotice(
          'The audio could not be prepared. You can still share the recording link.',
        );
        reportError('audio_export', 'decode', error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tab, recording, file, attempt]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setNotice('Link copied. Ready to share.');
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setNotice('Select and copy the link above.');
    }
  };
  const share = async (asFile: boolean) => {
    try {
      await navigator.share(
        asFile && file
          ? { files: [file], title: recording.commonName }
          : {
              title: `${recording.commonName} · Better Birds`,
              text: `Listen to ${recording.commonName} at StoutBats.`,
              url,
            },
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      setNotice(
        'Sharing could not open. Try copying the link or downloading the file.',
      );
      reportError('recording_share', 'unavailable', error);
    }
  };
  const download = () => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = file.name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    setNotice('Your audio file is ready to save.');
  };
  const canShareFile = !!file && !!navigator.canShare?.({ files: [file] });

  return (
    <dialog
      ref={dialogRef}
      className="share-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="share-title"
    >
      <div className="dialog-body">
        <button
          className="icon-button close-dialog"
          onClick={onClose}
          aria-label="Close sharing"
        >
          <X size={22} />
        </button>
        <div className="dialog-emblem">
          <Share2 size={25} />
        </div>
        <p className="eyebrow">Pass it on</p>
        <h2 id="share-title">A sound worth sharing.</h2>
        <div className="share-recording">
          <strong>{recording.commonName}</strong>
          <span>
            {recordingDate(recording.timestamp)} ·{' '}
            {recordingTime(recording.timestamp)} ET · StoutBats
          </span>
        </div>
        <div className="share-tabs" role="group" aria-label="Share format">
          <button
            aria-pressed={tab === 'link'}
            onClick={() => {
              setTab('link');
              setNotice('');
            }}
          >
            <Link size={17} /> Recording link
          </button>
          <button
            aria-pressed={tab === 'audio'}
            onClick={() => {
              setTab('audio');
              setNotice('');
            }}
            disabled={!recording.audioUrl}
          >
            <FileAudio size={17} /> Audio file
          </button>
        </div>
        {tab === 'link' ? (
          <div className="share-panel">
            <p>One link, straight to this recording. No account needed.</p>
            <label className="sr-only" htmlFor="recording-link">
              Recording link
            </label>
            <input
              ref={inputRef}
              id="recording-link"
              className="share-link"
              value={url}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <div className="share-actions">
              <button className="primary-button" onClick={() => void copy()}>
                {copied ? <Check size={18} /> : <Copy size={18} />}
                {copied ? 'Copied' : 'Copy link'}
              </button>
              {!!navigator.share && (
                <button
                  className="secondary-button"
                  onClick={() => void share(false)}
                >
                  <Share2 size={18} /> Share…
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="share-panel">
            <p>
              {recording.classification === 'bat'
                ? 'An audible version, slowed 10× for bat listening.'
                : 'The call as an audio file, ready to keep or send.'}
            </p>
            <div className="file-preview">
              <FileAudio size={26} />
              <div>
                <strong>
                  {loading
                    ? 'Preparing your audio…'
                    : file
                      ? 'WAV audio'
                      : 'Audio unavailable'}{' '}
                </strong>
                <span>
                  {file
                    ? `${clock(duration)} · ${(file.size / 1024 / 1024).toFixed(1)} MB`
                    : 'Prepared on your device'}
                </span>
              </div>
              {loading && <LoaderCircle className="spin" size={22} />}
            </div>
            <div className="share-actions">
              {canShareFile && (
                <button
                  className="primary-button"
                  onClick={() => void share(true)}
                >
                  <Share2 size={18} /> Share audio…
                </button>
              )}
              <button
                className={canShareFile ? 'secondary-button' : 'primary-button'}
                disabled={!file}
                onClick={download}
              >
                <Download size={18} /> Download audio
              </button>
              {failed && (
                <button
                  className="secondary-button"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Try again
                </button>
              )}
            </div>
          </div>
        )}
        <p className="share-notice" role="status">
          {notice}
        </p>
      </div>
    </dialog>
  );
}
