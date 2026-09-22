import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Play } from 'lucide-react';
import { fetchCapabilities, requestJson } from './api';
import type { Capability } from './types';

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function capabilityPath(
  operation: Capability,
  values: Record<string, string>,
) {
  let path = operation.path;
  const params = new URLSearchParams();
  for (const parameter of operation.parameters || []) {
    const value = values[parameter.name] ?? String(parameter.default ?? '');
    if (parameter.required && !value.trim())
      throw new Error(`Enter ${parameter.label || parameter.name}.`);
    if (!value) continue;
    if (path.includes(`:${parameter.name}`))
      path = path.replace(`:${parameter.name}`, encodeURIComponent(value));
    else params.set(parameter.name, value);
  }
  if (/:[a-zA-Z]/.test(path) || !path.startsWith('/api/'))
    throw new Error('This operation has an invalid local path.');
  return `${path}${params.size ? `${path.includes('?') ? '&' : '?'}${params}` : ''}`;
}

export function DataExplorer() {
  const [operations, setOperations] = useState<Capability[]>([]);
  const [selected, setSelected] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchCapabilities(controller.signal)
      .then((data) => {
        setOperations(data.operations);
        setSelected(data.operations[0]?.id || '');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, []);
  const operation = operations.find((operation) => operation.id === selected);
  const run = async () => {
    if (!operation) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await requestJson(
        capabilityPath(operation, values),
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(data);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : 'This report could not load.',
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return (
    <section className="journal-section">
      <div className="section-intro">
        <p className="eyebrow">For the curious</p>
        <h2>Open the notebook.</h2>
        <p>
          Explore the full station reports, including details beyond the charts.
          Every available report can be downloaded as JSON.
        </p>
      </div>
      {catalogLoading ? (
        <p className="status-note" role="status">
          Finding the station’s reports…
        </p>
      ) : (
        <form
          className="explorer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <label>
            Report
            <select
              value={selected}
              onChange={(event) => {
                request.current?.abort();
                setLoading(false);
                setSelected(event.target.value);
                setValues({});
                setResult(null);
                setError('');
              }}
            >
              {operations.map((operation) => (
                <option key={operation.id} value={operation.id}>
                  {operation.label}
                </option>
              ))}
            </select>
          </label>
          {operation && (
            <>
              <p>{operation.description}</p>
              <div className="explorer-parameters">
                {operation.parameters?.map((parameter) => (
                  <label key={parameter.name}>
                    {parameter.label || parameter.name}
                    {parameter.required ? ' *' : ''}
                    {parameter.options ? (
                      <select
                        value={
                          values[parameter.name] ??
                          String(parameter.default ?? '')
                        }
                        required={parameter.required}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [parameter.name]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Default</option>
                        {parameter.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={parameter.type === 'number' ? 'number' : 'text'}
                        value={
                          values[parameter.name] ??
                          String(parameter.default ?? '')
                        }
                        required={parameter.required}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [parameter.name]: event.target.value,
                          }))
                        }
                      />
                    )}
                  </label>
                ))}
              </div>
            </>
          )}
          <button className="primary-button" disabled={!operation || loading}>
            {loading ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <Play size={17} />
            )}
            {loading ? 'Reading report…' : 'Open report'}
          </button>
        </form>
      )}
      {error && (
        <div className="feed-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {result !== null && (
        <section className="json-result">
          <div className="panel-heading">
            <h3>{operation?.label}</h3>
            <button
              className="secondary-button"
              onClick={() => downloadJson(result, `farts-${selected}.json`)}
            >
              <Download size={16} /> Download JSON
            </button>
          </div>
          <pre tabIndex={0} aria-label="Report JSON">
            {JSON.stringify(result, null, 2)}
          </pre>
        </section>
      )}
    </section>
  );
}
