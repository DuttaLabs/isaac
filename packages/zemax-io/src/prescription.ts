/**
 * Reader for OpticStudio's **System/Prescription Data** report — the text file
 * its Reports menu writes out, listing everything the program believes about a
 * lens.
 *
 * This is not a lens file and Isaac will never write one. It is here because
 * reading what OpticStudio says about a design is the only way to check Isaac
 * against it, and the report is a Zemax text format like any other: understanding
 * those is this package's job. `prescription-compare.ts` is what does the
 * checking; this file only turns the text into data.
 *
 * ### Masked digits
 *
 * Under a licence that does not permit full disclosure OpticStudio replaces the
 * trailing digits of a number with `X`: `974.011X`, `-3.585XXXe-15`,
 * `0.000XXE+00`. **Such a value is a range, not a number**, and reading one as a
 * number — by stripping the `X`s, or by parsing up to them — invents precision
 * the report deliberately withheld. Every value here therefore arrives as a
 * {@link PrescriptionValue} carrying the interval it stands for, and a
 * comparison against it can only ask whether a number falls inside.
 *
 * Two limits decide where the interval ends, and both are read off the report
 * rather than assumed:
 *
 * - **The mask begins at a fixed decimal place.** In the one export measured,
 *   all 1743 masked values show exactly three decimals before the first `X`,
 *   whatever their magnitude — so the licence masks by decimal place, not by
 *   field width. {@link inferMaskedDecimals} counts it from the text, so a
 *   licence that shows a different number needs no change here.
 * - **The rendering carries about seven significant figures**, which cuts in
 *   first on a large value: `-109987.5` is a radius of `-109987.496020` printed
 *   to seven figures and so to *one* decimal, unmasked. Reading its slack as
 *   three decimals would call the true value a disagreement.
 *
 * So the interval runs to half a unit at whichever place the report could last
 * have printed — and never tighter than what it did print, which is what makes
 * a masked value's own `X` positions govern. That is the safe direction on both
 * counts: a value with suppressed trailing zeros (`40`, `0`) is pinned properly
 * instead of being given a useless half-unit range, and a large one is given
 * the room its rendering actually needs.
 *
 * {@link PrescriptionValue.significantDigits} says how strong a check against
 * the value is, so agreement with a value that pinned nothing can be reported
 * as the non-event it is rather than counted as a pass.
 */

import { decodeZmx } from './decode.ts';

/**
 * A number as the report printed it, which under a masking licence is an
 * interval rather than a value.
 */
export interface PrescriptionValue {
  /** Exactly as printed, `X`s included. */
  readonly text: string;
  /** Lowest value consistent with what was printed. */
  readonly low: number;
  /** Highest value consistent with what was printed. */
  readonly high: number;
  /** How many digits the licence replaced with `X`. */
  readonly maskedDigits: number;
  /**
   * Leading significant digits that were actually printed — how much a check
   * against this value proves. Zero means the report pinned nothing at all.
   * `Infinity` for an exact token such as `Infinity` itself.
   */
  readonly significantDigits: number;
}

/** How much precision a report shows before the licence takes over. */
export interface PrescriptionPrecision {
  /**
   * Decimal places shown before masking begins. Counted from the report by
   * {@link inferMaskedDecimals}; 3 in every export measured so far.
   */
  readonly maskedDecimals: number;
  /**
   * Significant figures the underlying rendering carries, which limits a large
   * value before the decimal place does. Seven is what `-109987.5` shows, and
   * it is used only to *widen* an interval, never to tighten one.
   */
  readonly significantDigits: number;
}

export const DEFAULT_PRESCRIPTION_PRECISION: PrescriptionPrecision = {
  maskedDecimals: 3,
  significantDigits: 7,
};

const MASKED_FRACTION = /\.([0-9]*)X/g;

/**
 * Counts the decimal places a report shows before the mask starts, by looking
 * at every masked value in it. Returns `undefined` when nothing is masked, in
 * which case the licence is not withholding anything and the printed digits
 * stand on their own.
 */
export function inferMaskedDecimals(text: string): number | undefined {
  let shown: number | undefined;
  for (const match of text.matchAll(MASKED_FRACTION)) {
    const places = match[1]!.length;
    if (shown === undefined || places > shown) shown = places;
  }
  return shown;
}

/** One `Label : value` line of the general lens data block. */
export interface PrescriptionEntry {
  readonly label: string;
  /** First non-empty field after the colon. */
  readonly value: string;
  /** Any further tab-separated fields, such as the EFL's `(in image space)`. */
  readonly extra: readonly string[];
}

/** A row of `SURFACE DATA SUMMARY`, with its `SURFACE DATA DETAIL` block folded in. */
export interface PrescriptionSurface {
  /** As printed in the Surf column: `OBJ`, `STO`, `IMA`, or the number. */
  readonly label: string;
  /** Position in the surface list, which is what the label stands for. */
  readonly index: number;
  readonly isStop: boolean;
  /** `STANDARD`, `EVENASPH`, `COORDBRK`, … */
  readonly type: string;
  readonly radius: PrescriptionValue | undefined;
  /** Absent on the image surface, which has nothing after it. */
  readonly thickness: PrescriptionValue | undefined;
  /**
   * The Glass column verbatim. A named glass is its name; a **model** glass is
   * printed as `nd, Vd` — `1.560XXX,  0.000XXX` — and empty means air.
   */
  readonly glass: string;
  /**
   * The clear-aperture column. OpticStudio writes it as a **diameter** where
   * Isaac stores a semi-diameter, so it is halved before any comparison —
   * unless the report headed the column `Clear Semi-Diam`, which some do, and
   * then {@link clearDiameterIsSemi} says not to halve it again.
   */
  readonly clearDiameter: PrescriptionValue | undefined;
  /** Whether that column was already a semi-diameter. */
  readonly clearDiameterIsSemi: boolean;
  readonly conic: PrescriptionValue | undefined;
  readonly comment: string;
  /**
   * Aspheric coefficients from the detail block, indexed as Isaac indexes them:
   * `[0]` is the coefficient on r², matching `Surface.asphericCoefficients`.
   * Empty on a surface that printed none.
   */
  readonly asphericCoefficients: readonly (PrescriptionValue | undefined)[];
}

/** One field point. */
export interface PrescriptionField {
  readonly x: number;
  readonly y: number;
  readonly weight: number;
  /** As printed, so a comparison can use the precision the report actually gave. */
  readonly xText: string;
  readonly yText: string;
}

/** One wavelength, in micrometres as the report gives them. */
export interface PrescriptionWavelength {
  readonly um: number;
  readonly weight: number;
  /** As printed. `0.587562` is a rounding of 0.5875618, not a different number. */
  readonly umText: string;
}

/** A row of the cardinal points table, which states each quantity in both spaces. */
export interface PrescriptionCardinalRow {
  readonly objectSpace: PrescriptionValue | undefined;
  readonly imageSpace: PrescriptionValue | undefined;
}

/**
 * The cardinal points at one wavelength.
 *
 * **Read {@link conventions} before comparing anything here.** The block states
 * its own reference points in prose, and they are not Isaac's: object-space
 * positions are measured from surface 1, image-space positions from the *image
 * surface*, and both have the index of their space divided out.
 */
export interface PrescriptionCardinalPoints {
  readonly wavelengthUm: number;
  readonly isPrimary: boolean;
  readonly rows: ReadonlyMap<string, PrescriptionCardinalRow>;
}

/** The whole report. */
export interface ZmxPrescription {
  /** The `File :` line — the path OpticStudio read the design from. */
  readonly file: string;
  readonly title: string;
  readonly date: string;
  /** The precision this report was read at — inferred from it unless overridden. */
  readonly precision: PrescriptionPrecision;
  readonly general: readonly PrescriptionEntry[];
  readonly fields: readonly PrescriptionField[];
  readonly wavelengths: readonly PrescriptionWavelength[];
  readonly surfaces: readonly PrescriptionSurface[];
  readonly cardinalPoints: readonly PrescriptionCardinalPoints[];
  /**
   * The sentences the cardinal points block states its own reference frame in,
   * verbatim. Kept so a comparison can check the conventions it assumes are
   * still the ones the report is using rather than trusting a note in a file.
   */
  readonly conventions: readonly string[];
  /** Section headers found, in order — useful when a report is missing one. */
  readonly sections: readonly string[];
  /** Anything that did not parse the way it should have. */
  readonly warnings: readonly string[];
}

const INFINITY = /^([+-]?)Infinity$/i;
const NUMBER = /^([+-]?)([0-9X]+)(?:\.([0-9X]*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Reads one printed number as the interval it stands for, or `undefined` if the
 * text is blank or is not a number at all.
 */
export function parsePrescriptionValue(
  raw: string,
  precision: PrescriptionPrecision = DEFAULT_PRESCRIPTION_PRECISION,
): PrescriptionValue | undefined {
  const text = raw.trim();
  if (text === '') return undefined;

  const infinite = INFINITY.exec(text);
  if (infinite !== null) {
    const value = infinite[1] === '-' ? -Infinity : Infinity;
    return { text, low: value, high: value, maskedDigits: 0, significantDigits: Infinity };
  }

  const match = NUMBER.exec(text);
  if (match === null) return undefined;

  const negative = match[1] === '-';
  const whole = match[2]!;
  const fraction = match[3] ?? '';
  const exponent = match[4] === undefined ? 0 : Number(match[4]);

  const printed = `${whole}.${fraction === '' ? '0' : fraction}`;
  const lowest = Number(printed.replaceAll('X', '0'));
  const highest = Number(printed.replaceAll('X', '9'));
  if (!Number.isFinite(lowest) || !Number.isFinite(highest)) return undefined;

  // Half a unit at the last place the report could have printed. Trailing zeros
  // are suppressed, so `40` and `0` printed no fraction at all and would carry a
  // useless half-unit range if the printed length were taken at face value.
  const wholeDigits = whole.replace(/^0+/, '').length || 1;
  const allowed = Math.max(
    0,
    Math.min(precision.maskedDecimals, precision.significantDigits - wholeDigits),
  );
  const places = Math.max(fraction.length, allowed);
  const slack = 10 ** -places / 2;

  const scale = 10 ** exponent;
  const lowMagnitude = (lowest - slack) * scale;
  const highMagnitude = (highest + slack) * scale;

  const digits = (whole + fraction).replace(/^0+/, '');
  const firstMask = digits.indexOf('X');

  return {
    text,
    low: negative ? -highMagnitude : lowMagnitude,
    high: negative ? -lowMagnitude : highMagnitude,
    maskedDigits: (whole + fraction).split('X').length - 1,
    significantDigits: firstMask === -1 ? digits.length : firstMask,
  };
}

/** Whether a number falls inside what the report printed. */
export function valueContains(value: PrescriptionValue, actual: number): boolean {
  if (!Number.isFinite(actual)) return actual === value.low && actual === value.high;
  return actual >= value.low && actual <= value.high;
}

/** Midpoint of the interval — for display only; never compare against it. */
export function valueMidpoint(value: PrescriptionValue): number {
  if (value.low === value.high) return value.low;
  return (value.low + value.high) / 2;
}

/** A line that is nothing but an upper-case heading ending in a colon. */
const SECTION = /^[A-Z][A-Z0-9 /()'’,.&#+-]*:$/;

function splitSections(lines: readonly string[]): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let name = '';
  let body: string[] = [];
  for (const line of lines) {
    if (SECTION.test(line.trim())) {
      if (name !== '') sections.set(name, body);
      name = line.trim();
      body = [];
      continue;
    }
    if (name !== '') body.push(line);
  }
  if (name !== '') sections.set(name, body);
  return sections;
}

function parseEntries(lines: readonly string[]): PrescriptionEntry[] {
  const entries: PrescriptionEntry[] = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const label = line.slice(0, colon).trim();
    if (label === '' || label.includes('\t')) continue;
    const parts = line
      .slice(colon + 1)
      .split('\t')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    entries.push({ label, value: parts[0] ?? '', extra: parts.slice(1) });
  }
  return entries;
}

/**
 * The first entry with this label, optionally the one whose trailing note
 * contains a phrase — the general block states the focal length twice, once in
 * air and once in image space, under the very same label.
 */
export function generalEntry(
  prescription: ZmxPrescription,
  label: string,
  extraContains?: string,
): PrescriptionEntry | undefined {
  return prescription.general.find(
    (entry) =>
      entry.label === label &&
      (extraContains === undefined ||
        entry.extra.some((note) => note.toLowerCase().includes(extraContains.toLowerCase()))),
  );
}

/** The value of a general entry, read as an interval. */
export function generalValue(
  prescription: ZmxPrescription,
  label: string,
  extraContains?: string,
): PrescriptionValue | undefined {
  const entry = generalEntry(prescription, label, extraContains);
  return entry === undefined
    ? undefined
    : parsePrescriptionValue(entry.value, prescription.precision);
}

/**
 * The wavelength the report's first-order figures are stated at, in nanometers.
 *
 * Not simply the first in the list: OpticStudio's primary wavelength is whichever
 * one `PWAV` names, and a report that lists F, d and C states its focal length at
 * d. Comparing at the wrong one is a disagreement in every dispersive quantity
 * at once, which reads as a broken lens rather than a broken question.
 */
export function primaryWavelengthNm(prescription: ZmxPrescription): number | undefined {
  const stated = prescription.general.find((entry) => entry.label.startsWith('Primary Wavelength'));
  const value = stated === undefined ? undefined : parsePrescriptionValue(stated.value);
  if (value !== undefined && Number.isFinite(value.low)) return valueMidpoint(value) * 1000;

  const primaryBlock = prescription.cardinalPoints.find((block) => block.isPrimary);
  if (primaryBlock !== undefined && Number.isFinite(primaryBlock.wavelengthUm)) {
    return primaryBlock.wavelengthUm * 1000;
  }
  const first = prescription.wavelengths[0];
  return first === undefined ? undefined : first.um * 1000;
}

const NUMBERED_ROW = /^\s*\d+\s*$/;

function parseNumberedRows(lines: readonly string[], startsAfter: RegExp): string[][] {
  const rows: string[][] = [];
  let started = false;
  for (const line of lines) {
    if (!started) {
      if (startsAfter.test(line)) started = true;
      continue;
    }
    const cells = line.split('\t').map((cell) => cell.trim());
    if (!NUMBERED_ROW.test(cells[0] ?? '')) break;
    rows.push(cells);
  }
  return rows;
}

function parseFields(lines: readonly string[]): PrescriptionField[] {
  return parseNumberedRows(lines, /X-Value/).map((cells) => ({
    x: Number(cells[1]),
    y: Number(cells[2]),
    weight: Number(cells[3]),
    xText: cells[1] ?? '',
    yText: cells[2] ?? '',
  }));
}

function parseWavelengths(lines: readonly string[]): PrescriptionWavelength[] {
  return parseNumberedRows(lines, /^\s*#\s*\tValue/).map((cells) => ({
    um: Number(cells[1]),
    weight: Number(cells[2]),
    umText: cells[1] ?? '',
  }));
}

const COLUMN_ALIASES: Record<string, string> = {
  surf: 'surf',
  type: 'type',
  radius: 'radius',
  thickness: 'thickness',
  glass: 'glass',
  'clear diam': 'clearDiameter',
  'clear semi-diam': 'clearSemiDiameter',
  conic: 'conic',
  comment: 'comment',
};

function parseSurfaceSummary(
  lines: readonly string[],
  precision: PrescriptionPrecision,
  warnings: string[],
) {
  const header = lines.find((line) => line.trimStart().startsWith('Surf'));
  if (header === undefined) {
    warnings.push('SURFACE DATA SUMMARY has no column header row.');
    return [];
  }
  const columns = new Map<string, number>();
  header.split('\t').forEach((cell, position) => {
    const key = COLUMN_ALIASES[cell.trim().toLowerCase()];
    if (key !== undefined) columns.set(key, position);
  });

  const cellOf = (cells: string[], key: string): string => {
    const position = columns.get(key);
    return position === undefined ? '' : (cells[position] ?? '').trim();
  };

  const rows: Omit<PrescriptionSurface, 'asphericCoefficients' | 'clearDiameterIsSemi'>[] = [];
  let seen = false;
  for (const line of lines.slice(lines.indexOf(header) + 1)) {
    const cells = line.split('\t');
    const label = (cells[0] ?? '').trim();
    if (label === '') {
      if (seen) break;
      continue;
    }
    seen = true;
    const index = rows.length;
    if (/^\d+$/.test(label) && Number(label) !== index) {
      warnings.push(
        `Surface row ${index} is labelled ${label}; the summary is not a complete run.`,
      );
    }
    // A report may state the semi-diameter instead of the diameter; keep the
    // column's own meaning rather than converting here.
    const diameter = cellOf(cells, 'clearDiameter');
    const semi = cellOf(cells, 'clearSemiDiameter');
    rows.push({
      label,
      index,
      isStop: label === 'STO',
      type: cellOf(cells, 'type'),
      radius: parsePrescriptionValue(cellOf(cells, 'radius'), precision),
      thickness: parsePrescriptionValue(cellOf(cells, 'thickness'), precision),
      glass: cellOf(cells, 'glass'),
      clearDiameter: parsePrescriptionValue(diameter !== '' ? diameter : semi, precision),
      conic: parsePrescriptionValue(cellOf(cells, 'conic'), precision),
      comment: cellOf(cells, 'comment'),
    });
  }
  const halved = columns.has('clearSemiDiameter') && !columns.has('clearDiameter');
  return rows.map((row) => ({ ...row, clearDiameterIsSemi: halved }));
}

const DETAIL_HEADING = /^Surface\s+(\S+)\s+(\S+)\s*$/;
const COEFFICIENT = /^Coefficient on r\^\s*(\d+)\s*:\s*(\S+)/;

function parseAsphericCoefficients(
  lines: readonly string[],
  precision: PrescriptionPrecision,
): Map<string, (PrescriptionValue | undefined)[]> {
  const byLabel = new Map<string, (PrescriptionValue | undefined)[]>();
  let label = '';
  for (const line of lines) {
    const heading = DETAIL_HEADING.exec(line.trim());
    if (heading !== null) {
      label = heading[1]!;
      continue;
    }
    const coefficient = COEFFICIENT.exec(line.trim());
    if (coefficient === null || label === '') continue;
    const power = Number(coefficient[1]);
    if (power < 2 || power % 2 !== 0) continue;
    // r² is Isaac's α₁ and sits at index 0 — the whole series is one power
    // along from where a reader expects it. See zmx-evenasph-parm-offset.
    const slot = power / 2 - 1;
    const list = byLabel.get(label) ?? [];
    list[slot] = parsePrescriptionValue(coefficient[2]!, precision);
    byLabel.set(label, list);
  }
  return byLabel;
}

const CARDINAL_WAVELENGTH = /^W\s*=\s*\t?\s*([0-9.]+)\s*\t?\s*(\(Primary\))?/;
const CARDINAL_ROW = /^([A-Za-z][A-Za-z -]*[A-Za-z])\s*:\s*\t(.*)$/;

function parseCardinalPoints(lines: readonly string[], precision: PrescriptionPrecision) {
  const blocks: PrescriptionCardinalPoints[] = [];
  const conventions: string[] = [];
  let wavelengthUm = Number.NaN;
  let isPrimary = false;
  let rows = new Map<string, PrescriptionCardinalRow>();

  const flush = () => {
    if (rows.size > 0) blocks.push({ wavelengthUm, isPrimary, rows });
    rows = new Map();
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith('.') && /measured with respect to|index in both/i.test(trimmed)) {
      conventions.push(trimmed);
      continue;
    }
    const wavelength = CARDINAL_WAVELENGTH.exec(trimmed);
    if (wavelength !== null) {
      flush();
      wavelengthUm = Number(wavelength[1]);
      isPrimary = wavelength[2] !== undefined;
      continue;
    }
    const row = CARDINAL_ROW.exec(line.replace(/\r$/, ''));
    if (row === null) continue;
    const cells = row[2]!.split('\t').map((cell) => cell.trim());
    rows.set(row[1]!.trim(), {
      objectSpace: parsePrescriptionValue(cells[0] ?? '', precision),
      imageSpace: parsePrescriptionValue(cells[1] ?? '', precision),
    });
  }
  flush();
  return { blocks, conventions };
}

function headerLine(lines: readonly string[], label: string): string {
  const line = lines.find((candidate) => candidate.trimStart().startsWith(`${label}`));
  if (line === undefined) return '';
  const colon = line.indexOf(':');
  return colon === -1 ? '' : line.slice(colon + 1).trim();
}

/**
 * Parses a System/Prescription Data report.
 *
 * Accepts bytes as well as text, and decodes them the same way a `.zmx` is
 * decoded — OpticStudio writes some of these as UTF-16.
 */
export function parsePrescription(
  input: string | Uint8Array,
  options: { precision?: PrescriptionPrecision } = {},
): ZmxPrescription {
  const text = typeof input === 'string' ? input : decodeZmx(input);
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];
  const sections = splitSections(lines);
  const maskedDecimals = inferMaskedDecimals(text);
  const precision: PrescriptionPrecision = options.precision ?? {
    ...DEFAULT_PRESCRIPTION_PRECISION,
    ...(maskedDecimals === undefined ? {} : { maskedDecimals }),
  };

  const generalLines = sections.get('GENERAL LENS DATA:') ?? [];
  if (generalLines.length === 0) warnings.push('No GENERAL LENS DATA section.');

  const summaryLines = sections.get('SURFACE DATA SUMMARY:') ?? [];
  if (summaryLines.length === 0) warnings.push('No SURFACE DATA SUMMARY section.');
  const summary = parseSurfaceSummary(summaryLines, precision, warnings);

  const detail = parseAsphericCoefficients(sections.get('SURFACE DATA DETAIL:') ?? [], precision);
  const surfaces: PrescriptionSurface[] = summary.map((row) => ({
    ...row,
    asphericCoefficients: detail.get(row.label) ?? [],
  }));

  const cardinal = parseCardinalPoints(sections.get('CARDINAL POINTS:') ?? [], precision);

  return {
    file: headerLine(lines, 'File '),
    title: headerLine(lines, 'Title'),
    date: headerLine(lines, 'Date '),
    precision,
    general: parseEntries(generalLines),
    fields: parseFields(generalLines),
    wavelengths: parseWavelengths(generalLines),
    surfaces,
    cardinalPoints: cardinal.blocks,
    conventions: cardinal.conventions,
    sections: [...sections.keys()],
    warnings,
  };
}
