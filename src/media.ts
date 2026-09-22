export function localMedia(value: unknown): string | null {
  return typeof value === 'string' && /^\/media\/[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}
