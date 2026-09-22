import { useEffect, useRef, useState } from 'react';
import { fetchConfig } from './api';

const CHECK_INTERVAL = 60_000;

export function useVersionWatch(
  version: string,
  busy: boolean,
  reload = () => window.location.reload(),
) {
  const [available, setAvailable] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (version === 'development') return;
    let checked = 0;
    let controller: AbortController | null = null;
    const check = () => {
      if (
        document.visibilityState !== 'visible' ||
        Date.now() - checked < CHECK_INTERVAL
      )
        return;
      checked = Date.now();
      controller?.abort();
      controller = new AbortController();
      fetchConfig(controller.signal)
        .then((config) => {
          if (config.version === version) return;
          if (busyRef.current) setAvailable(true);
          else reload();
        })
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      controller?.abort();
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [version, reload]);
  return available;
}
