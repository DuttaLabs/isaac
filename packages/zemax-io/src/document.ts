/**
 * Stage one of reading a .zmx file: a faithful, loss-free view of its lines.
 *
 * A ZMX file is a flat list of whitespace-delimited records. Records before the
 * first `SURF` describe the system; everything after a `SURF n` line belongs to
 * that surface until the next `SURF`. Nothing is interpreted here — that is
 * stage two ({@link ../import.ts}) — so unknown or future tokens survive intact.
 */

export interface ZmxRecord {
  /** The leading token, upper-cased (e.g. `CURV`). */
  token: string;
  /** Whitespace-delimited values following the token, verbatim. */
  values: readonly string[];
  /** 1-based line number in the source text, for error messages. */
  line: number;
}

export interface ZmxSurfaceBlock {
  /** The surface number as written on its `SURF` line. */
  number: number;
  records: readonly ZmxRecord[];
}

export interface ZmxDocument {
  /** Records appearing before the first `SURF` line. */
  header: readonly ZmxRecord[];
  surfaces: readonly ZmxSurfaceBlock[];
  /** Records after the surface list (tolerance data, metadata, …). */
  trailer: readonly ZmxRecord[];
}

/** Splits ZMX text into header, surface blocks, and trailer records. */
export function parseZmxDocument(text: string): ZmxDocument {
  const header: ZmxRecord[] = [];
  const surfaces: ZmxSurfaceBlock[] = [];
  const trailer: ZmxRecord[] = [];

  let current: { number: number; records: ZmxRecord[] } | undefined;
  let sawSurface = false;

  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const record = parseRecord(lines[i]!, i + 1);
    if (!record) {
      continue;
    }

    if (record.token === 'SURF') {
      const number = Number(record.values[0]);
      if (!Number.isInteger(number)) {
        throw new SyntaxError(`Line ${record.line}: SURF needs an integer surface number.`);
      }
      current = { number, records: [] };
      surfaces.push(current);
      sawSurface = true;
      continue;
    }

    // Trailer records are flush-left; indented lines still belong to the surface.
    if (current && !sawTrailerStart(record, lines[i]!)) {
      current.records.push(record);
    } else if (sawSurface) {
      current = undefined;
      trailer.push(record);
    } else {
      header.push(record);
    }
  }

  return { header, surfaces, trailer };
}

/** The first value of the first record with this token, or `undefined`. */
export function firstValue(records: readonly ZmxRecord[], token: string): string | undefined {
  return findRecord(records, token)?.values[0];
}

/** The first record with this token, or `undefined`. */
export function findRecord(records: readonly ZmxRecord[], token: string): ZmxRecord | undefined {
  return records.find((record) => record.token === token);
}

/** Every record with this token, in file order. */
export function findRecords(records: readonly ZmxRecord[], token: string): ZmxRecord[] {
  return records.filter((record) => record.token === token);
}

/** True when a record with this token is present (for flag tokens like `STOP`). */
export function hasRecord(records: readonly ZmxRecord[], token: string): boolean {
  return records.some((record) => record.token === token);
}

/** Parses a value as a finite number, or returns `undefined` if it is absent or not numeric. */
export function numericValue(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRecord(line: string, lineNumber: number): ZmxRecord | undefined {
  const trimmed = line.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parts = trimmed.split(/\s+/);
  const token = parts[0]!;
  return { token: token.toUpperCase(), values: parts.slice(1), line: lineNumber };
}

/**
 * Surface records are indented in every file Zemax writes; trailing metadata
 * (TOL, MNUM, TRAR, …) is flush-left. Indentation is the only structural cue
 * the format gives for where the surface list ends.
 */
function sawTrailerStart(record: ZmxRecord, rawLine: string): boolean {
  return !/^\s/.test(rawLine) && record.token !== 'SURF';
}
