import { useCallback, useEffect, useState } from 'react';

export type View = 'journal' | 'species' | 'activity' | 'station' | 'data';
export type Period = 'day' | 'week' | 'month' | 'all';
export type Filter = 'all' | 'bird' | 'bat';
export function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get('view') || 'journal';
  const requestedPeriod = params.get('period') || 'week';
  const requestedFilter = params.get('classification') || 'all';
  return {
    view: (['journal', 'species', 'activity', 'station', 'data'].includes(
      requestedView,
    )
      ? requestedView
      : 'journal') as View,
    period: (['day', 'week', 'month', 'all'].includes(requestedPeriod)
      ? requestedPeriod
      : 'week') as Period,
    classification: (['all', 'bird', 'bat'].includes(requestedFilter)
      ? requestedFilter
      : 'all') as Filter,
    query: params.get('query') || '',
    speciesId: params.get('speciesId') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
    detailId:
      window.location.pathname.match(
        /^\/recordings\/([1-9]\d{0,19})\/?$/,
      )?.[1] || '',
    invalid:
      window.location.pathname !== '/' &&
      !/^\/recordings\/[1-9]\d{0,19}\/?$/.test(window.location.pathname),
  };
}

export function useRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback(
    (changes: Partial<ReturnType<typeof readRoute>>, replace = false) => {
      const current = readRoute();
      const next = { ...current, ...changes };
      const params = new URLSearchParams();
      for (const key of [
        'view',
        'period',
        'classification',
        'query',
        'speciesId',
        'from',
        'to',
      ] as const) {
        if (next[key] && !(key === 'view' && next[key] === 'journal'))
          params.set(key, next[key]);
      }
      const path = next.detailId ? `/recordings/${next.detailId}` : '/';
      window.history[replace ? 'replaceState' : 'pushState'](
        {},
        '',
        `${path}${params.size ? `?${params}` : ''}`,
      );
      setRoute(readRoute());
    },
    [],
  );
  return { route, navigate };
}
