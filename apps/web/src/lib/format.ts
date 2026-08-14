/** Formats a length for the editor and readouts, keeping INFINITY readable. */
export function formatLength(value: number, digits = 4): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? 'Infinity' : '-Infinity';
  }
  if (value === 0) {
    return '0';
  }
  return Number(value.toFixed(digits)).toString();
}

/** Parses editor input, accepting `inf`/`infinity` and treating blank as a default. */
export function parseLength(text: string, fallback: number): number {
  const trimmed = text.trim();
  if (trimmed === '') {
    return fallback;
  }
  if (/^-?inf(inity)?$/i.test(trimmed)) {
    return trimmed.startsWith('-') ? -Infinity : Infinity;
  }
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Formats a value that may be infinite or undefined, for read-only displays. */
export function formatOptional(value: number | undefined, digits = 4, suffix = ''): string {
  if (value === undefined || Number.isNaN(value)) {
    return '—';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? '∞' : '−∞';
  }
  return `${Number(value.toFixed(digits))}${suffix}`;
}

/** Micrometres, for spot sizes, which are far below a millimetre. */
export function formatMicrons(millimetres: number): string {
  return `${(millimetres * 1000).toFixed(2)} µm`;
}
