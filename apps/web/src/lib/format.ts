/**
 * Formats a length for an editor cell. Infinity is shown as the symbol: it is
 * what a lens table conventionally prints, and spelling it out costs a column
 * more width than the number it replaces.
 */
export function formatLength(value: number, digits = 4): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? '∞' : '−∞';
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
  // Accept the symbol we print, the word, and the minus sign we render.
  if (/^[-−]?(inf(inity)?|∞)$/i.test(trimmed)) {
    return /^[-−]/.test(trimmed) ? -Infinity : Infinity;
  }
  const normalized = trimmed.replace(/^−/, '-');
  const parsedNormalized = Number(normalized);
  if (!Number.isNaN(parsedNormalized)) {
    return parsedNormalized;
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
