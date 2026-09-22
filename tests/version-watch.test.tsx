// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchConfig } from '../src/api';
import { useVersionWatch } from '../src/useVersionWatch';
import type { RuntimeConfig } from '../src/types';

vi.mock('../src/api', () => ({ fetchConfig: vi.fn() }));

const config: RuntimeConfig = {
  name: 'FARTS',
  stationId: '30605',
  stationName: 'StoutBats',
  stationDescription: '',
  timezone: 'UTC',
  version: '0.1.3',
  faroUrl: '',
  publicUrl: '',
};
const reload = vi.fn();
let root: Root;
let container: HTMLDivElement;
let available = false;

function Harness({ version, busy }: { version: string; busy: boolean }) {
  available = useVersionWatch(version, busy, reload);
  return null;
}

async function render(version: string, busy: boolean) {
  await act(async () => {
    root.render(<Harness version={version} busy={busy} />);
  });
}

async function returnToTab() {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(fetchConfig).mockReset().mockResolvedValue(config);
  reload.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('version watch', () => {
  it('reloads an idle tab that returns to a newer release', async () => {
    await render('0.1.2', false);
    expect(fetchConfig).not.toHaveBeenCalled();
    await returnToTab();
    expect(fetchConfig).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('offers a reload instead of interrupting playback', async () => {
    await render('0.1.2', true);
    await returnToTab();
    expect(reload).not.toHaveBeenCalled();
    expect(available).toBe(true);
  });

  it('stays quiet on the current release and checks at most once a minute', async () => {
    await render('0.1.3', false);
    await returnToTab();
    await returnToTab();
    expect(fetchConfig).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(available).toBe(false);
  });

  it('ignores development builds', async () => {
    await render('development', false);
    await returnToTab();
    expect(fetchConfig).not.toHaveBeenCalled();
  });
});
