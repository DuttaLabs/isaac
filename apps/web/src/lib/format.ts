/**
 * Formats a length for an editor cell. Infinity prints as `Inf` — the word a
 * user would type, in the same ASCII the rest of the column is in, rather than
 * a symbol that needs a character palette to enter.
 */
export const INFINITY_TEXT = 'Inf';

export function formatLength(value: number, digits = 4): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? INFINITY_TEXT : `-${INFINITY_TEXT}`;
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
  // Accept `Inf` as printed, the full word, and the symbol — still taken even
  // though it is no longer produced, since it costs nothing and a value pasted
  // from elsewhere may well use it. Either minus sign is allowed.
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
    return value > 0 ? INFINITY_TEXT : `-${INFINITY_TEXT}`;
  }
  return `${Number(value.toFixed(digits))}${suffix}`;
}

/** Micrometers, for spot sizes, which are far below a millimeter. */
export function formatMicrons(millimeters: number): string {
  return `${(millimeters * 1000).toFixed(2)} µm`;
}
