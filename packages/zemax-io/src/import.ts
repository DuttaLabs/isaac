import {
  AIR,
  ConstantMaterial,
  MATERIAL_CATALOG,
  OpticalSystem,
  Surface,
  type Aperture,
  type ApertureType,
  type Field,
  type LinearUnit,
  type Material,
} from '@isaac/optical-core';
import { decodeZmx } from './decode.ts';
import {
  findRecord,
  findRecords,
  firstValue,
  hasRecord,
  numericValue,
  parseZmxDocument,
  type ZmxDocument,
  type ZmxRecord,
  type ZmxSurfaceBlock,
} from './document.ts';

/** Thrown when a file cannot be mapped onto the optical-core model. */
export class ZmxImportError extends Error {
  public override name = 'ZmxImportError';
}

export interface ZmxImportOptions {
  /**
   * Resolves a ZMX glass name to a material. Defaults to a case-insensitive
   * lookup in `MATERIAL_CATALOG`; supply your own to plug in a glass catalog.
   */
  resolveMaterial?: (glassName: string) => Material | undefined;
  /**
   * When true, an unresolved glass becomes a placeholder of index
   * {@link UNKNOWN_GLASS_INDEX} and a warning, instead of failing the import.
   * The resulting system will not trace correctly — use it for layout only.
   */
  allowUnknownGlass?: boolean;
}

export interface ZmxGlassReference {
  name: string;
  surfaceNumber: number;
  resolved: boolean;
}

export interface ZmxImportResult {
  system: OpticalSystem;
  /** Things the file said that this reader could not honour exactly. */
  warnings: string[];
  /** Every glass the file names, and whether it resolved to a material. */
  glasses: readonly ZmxGlassReference[];
  /** Distinct tokens present in the file that this reader ignored. */
  ignoredTokens: readonly string[];
  /** The raw parsed document, for callers needing data this mapping drops. */
  document: ZmxDocument;
}

/** Refractive index substituted for an unresolved glass under `allowUnknownGlass`. */
export const UNKNOWN_GLASS_INDEX = 1.5;

/** Tokens this reader interprets; everything else is reported as ignored. */
const HANDLED_HEADER_TOKENS = new Set([
  'MODE',
  'NAME',
  'UNIT',
  'FTYP',
  'XFLN',
  'YFLN',
  'WAVM',
  'PWAV',
  'ENPD',
  'FNUM',
  'OBNA',
  'FLOA',
]);
const HANDLED_SURFACE_TOKENS = new Set(['TYPE', 'CURV', 'DISZ', 'DIAM', 'GLAS', 'STOP', 'CONI']);

/** Aperture tokens, mapped to the core's aperture types. */
const APERTURE_TOKENS: ReadonlyMap<string, ApertureType> = new Map([
  ['ENPD', 'ENTRANCE_PUPIL_DIAMETER'],
  ['FNUM', 'IMAGE_SPACE_FNUM'],
  ['OBNA', 'OBJECT_SPACE_NA'],
  ['FLOA', 'FLOAT_BY_STOP'],
]);

const UNITS: ReadonlyMap<string, LinearUnit> = new Map([
  ['MM', 'mm'],
  ['CM', 'cm'],
  ['M', 'm'],
  ['IN', 'in'],
]);

/** Reads a .zmx file (text or raw bytes) into an `OpticalSystem`. */
export function importZmx(
  source: string | Uint8Array,
  options: ZmxImportOptions = {},
): ZmxImportResult {
  const text = typeof source === 'string' ? source : decodeZmx(source);
  return zmxDocumentToSystem(parseZmxDocument(text), options);
}

/** Maps an already-parsed document onto the optical-core model. */
export function zmxDocumentToSystem(
  document: ZmxDocument,
  options: ZmxImportOptions = {},
): ZmxImportResult {
  const warnings: string[] = [];
  const glasses: ZmxGlassReference[] = [];
  const resolve = options.resolveMaterial ?? defaultResolveMaterial;

  const mode = firstValue(document.header, 'MODE');
  if (mode === undefined) {
    warnings.push('No MODE record; assuming a sequential system.');
  } else if (mode.toUpperCase() !== 'SEQ') {
    throw new ZmxImportError(`Only sequential (MODE SEQ) files are supported; this file is MODE ${mode}.`);
  }

  if (document.surfaces.length < 2) {
    throw new ZmxImportError(
      `A lens file needs at least an object and an image surface; found ${document.surfaces.length}.`,
    );
  }
  if (document.surfaces[0]!.number !== 0) {
    warnings.push(`Surface list starts at SURF ${document.surfaces[0]!.number}, not SURF 0.`);
  }

  const surfaces = document.surfaces.map((block, index) =>
    toSurface(block, index, document.surfaces.length, { resolve, options, warnings, glasses }),
  );

  const system = new OpticalSystem({
    name: readName(document) ?? 'Imported ZMX system',
    units: readUnits(document, warnings),
    wavelengthsNm: readWavelengths(document, warnings),
    primaryWavelengthIndex: readPrimaryWavelengthIndex(document, warnings),
    fields: readFields(document, warnings),
    aperture: readAperture(document, warnings),
    surfaces,
  });

  return {
    system,
    warnings,
    glasses,
    ignoredTokens: collectIgnoredTokens(document),
    document,
  };
}

interface SurfaceContext {
  resolve: (glassName: string) => Material | undefined;
  options: ZmxImportOptions;
  warnings: string[];
  glasses: ZmxGlassReference[];
}

function toSurface(
  block: ZmxSurfaceBlock,
  index: number,
  count: number,
  context: SurfaceContext,
): Surface {
  const { records, number } = block;

  const surfaceType = firstValue(records, 'TYPE')?.toUpperCase() ?? 'STANDARD';
  if (surfaceType !== 'STANDARD') {
    throw new ZmxImportError(
      `Surface ${number} is TYPE ${surfaceType}; only STANDARD surfaces are supported so far.`,
    );
  }

  const conic = numericValue(firstValue(records, 'CONI')) ?? 0;
  if (conic !== 0) {
    throw new ZmxImportError(
      `Surface ${number} has a conic constant (${conic}); conics and aspheres are not supported yet.`,
    );
  }

  const curvature = numericValue(firstValue(records, 'CURV')) ?? 0;
  const radius = curvature === 0 ? Infinity : 1 / curvature;

  const thickness = readThickness(records, number);
  // DIAM 0 means Zemax has no fixed aperture on the surface, not a zero aperture.
  const diameter = numericValue(firstValue(records, 'DIAM')) ?? 0;
  const semiDiameter = diameter > 0 ? diameter : Infinity;

  const isObject = index === 0;
  const isImage = index === count - 1;
  const type = isObject ? 'OBJECT' : isImage ? 'IMAGE' : 'STANDARD';

  let isStop = hasRecord(records, 'STOP');
  if (isStop && type !== 'STANDARD') {
    context.warnings.push(`Surface ${number} is marked STOP but is the ${type} surface; ignoring the stop.`);
    isStop = false;
  }

  return new Surface({
    id: `surf-${number}`,
    type,
    radius,
    thickness,
    semiDiameter,
    material: readMaterial(records, number, context),
    isStop,
    comment: readComment(records),
  });
}

function readThickness(records: readonly ZmxRecord[], surfaceNumber: number): number {
  const raw = firstValue(records, 'DISZ');
  if (raw === undefined) {
    return 0;
  }
  if (raw.toUpperCase() === 'INFINITY') {
    return Infinity;
  }
  const thickness = numericValue(raw);
  if (thickness === undefined) {
    throw new ZmxImportError(`Surface ${surfaceNumber} has an unreadable DISZ value "${raw}".`);
  }
  return thickness;
}

function readMaterial(
  records: readonly ZmxRecord[],
  surfaceNumber: number,
  context: SurfaceContext,
): Material {
  const glassName = firstValue(records, 'GLAS');
  if (glassName === undefined) {
    return AIR;
  }

  const material = context.resolve(glassName);
  context.glasses.push({ name: glassName, surfaceNumber, resolved: material !== undefined });
  if (material) {
    return material;
  }

  if (!context.options.allowUnknownGlass) {
    throw new ZmxImportError(
      `Unknown glass "${glassName}" on surface ${surfaceNumber}. Supply resolveMaterial, ` +
        'or set allowUnknownGlass to import it as a placeholder.',
    );
  }
  context.warnings.push(
    `Glass "${glassName}" on surface ${surfaceNumber} is unknown; substituting index ${UNKNOWN_GLASS_INDEX}. ` +
      'The system will not trace correctly.',
  );
  return new ConstantMaterial(glassName, UNKNOWN_GLASS_INDEX);
}

function readComment(records: readonly ZmxRecord[]): string | undefined {
  const comment = findRecord(records, 'COMM');
  return comment && comment.values.length > 0 ? comment.values.join(' ') : undefined;
}

function readName(document: ZmxDocument): string | undefined {
  const name = findRecord(document.header, 'NAME');
  return name && name.values.length > 0 ? name.values.join(' ') : undefined;
}

function readUnits(document: ZmxDocument, warnings: string[]): LinearUnit {
  const raw = firstValue(document.header, 'UNIT');
  if (raw === undefined) {
    return 'mm';
  }
  const unit = UNITS.get(raw.toUpperCase());
  if (!unit) {
    warnings.push(`Unrecognised UNIT "${raw}"; assuming millimetres.`);
    return 'mm';
  }
  return unit;
}

/**
 * `WAVM n λ weight` carries wavelengths in micrometres. Files pad the list out
 * to 24 entries, so the count from FTYP decides how many are real.
 */
function readWavelengths(document: ZmxDocument, warnings: string[]): number[] {
  const byNumber = new Map<number, number>();
  for (const record of findRecords(document.header, 'WAVM')) {
    const number = numericValue(record.values[0]);
    const micrometres = numericValue(record.values[1]);
    if (number === undefined || micrometres === undefined || micrometres <= 0) {
      continue;
    }
    byNumber.set(number, micrometres * 1000);
  }
  if (byNumber.size === 0) {
    warnings.push('No usable WAVM records; defaulting to the helium d-line.');
    return [587.5618];
  }

  const declared = readConfigCount(document, 3);
  const available = [...byNumber.keys()].sort((a, b) => a - b);
  const count = declared !== undefined ? Math.min(declared, available.length) : available.length;
  return available.slice(0, count).map((number) => byNumber.get(number)!);
}

function readPrimaryWavelengthIndex(document: ZmxDocument, warnings: string[]): number {
  const primary = numericValue(firstValue(document.header, 'PWAV'));
  if (primary === undefined) {
    return 0;
  }
  const index = primary - 1; // PWAV is 1-based
  const count = readWavelengths(document, []).length;
  if (index < 0 || index >= count) {
    warnings.push(`PWAV ${primary} is outside the wavelength list; using the first wavelength.`);
    return 0;
  }
  return index;
}

/**
 * `FTYP <field type> <telecentric> <field count> <wavelength count> …`, where
 * field type 0 is an angle in degrees and 1 an object height. Types 2 and 3
 * (paraxial and real image height) describe fields the core cannot express.
 */
function readFields(document: ZmxDocument, warnings: string[]): Field[] {
  const ftyp = findRecord(document.header, 'FTYP');
  if (!ftyp) {
    return [];
  }
  const fieldType = numericValue(ftyp.values[0]) ?? 0;
  if (fieldType !== 0 && fieldType !== 1) {
    warnings.push(
      `Field type ${fieldType} (image-height fields) is not supported; the imported system has no fields.`,
    );
    return [];
  }

  const yFields = readFieldValues(document, 'YFLN');
  const xFields = readFieldValues(document, 'XFLN');
  const declared = readConfigCount(document, 2);
  const count = declared !== undefined ? Math.min(declared, yFields.length) : yFields.length;

  if (xFields.slice(0, count).some((value) => value !== 0)) {
    warnings.push('X field points are present but the core models Y fields only; X values were dropped.');
  }

  return yFields
    .slice(0, count)
    .map((value) => (fieldType === 0 ? { angleDeg: value } : { objectHeight: value }));
}

function readFieldValues(document: ZmxDocument, token: string): number[] {
  const record = findRecord(document.header, token);
  if (!record) {
    return [];
  }
  return record.values.map((value) => numericValue(value) ?? 0);
}

/** Reads a count from the FTYP configuration line by value index. */
function readConfigCount(document: ZmxDocument, valueIndex: number): number | undefined {
  const ftyp = findRecord(document.header, 'FTYP');
  const count = numericValue(ftyp?.values[valueIndex]);
  return count !== undefined && count > 0 ? count : undefined;
}

/**
 * Picks the aperture definition. Files normally carry exactly one aperture
 * token; if several appear, the first in file order wins and the rest are
 * reported rather than silently discarded.
 */
function readAperture(document: ZmxDocument, warnings: string[]): Aperture | undefined {
  const found = document.header.filter((record) => APERTURE_TOKENS.has(record.token));
  if (found.length === 0) {
    return undefined;
  }
  if (found.length > 1) {
    warnings.push(
      `Several aperture records present (${found.map((r) => r.token).join(', ')}); using ${found[0]!.token}.`,
    );
  }

  const record = found[0]!;
  const type = APERTURE_TOKENS.get(record.token)!;
  if (type === 'FLOAT_BY_STOP') {
    return { type };
  }
  const value = numericValue(record.values[0]);
  if (value === undefined || value <= 0) {
    warnings.push(`${record.token} has no usable value; the imported system has no aperture.`);
    return undefined;
  }
  return { type, value };
}

function collectIgnoredTokens(document: ZmxDocument): string[] {
  const ignored = new Set<string>();
  for (const record of document.header) {
    if (!HANDLED_HEADER_TOKENS.has(record.token) && !APERTURE_TOKENS.has(record.token)) {
      ignored.add(record.token);
    }
  }
  for (const block of document.surfaces) {
    for (const record of block.records) {
      if (!HANDLED_SURFACE_TOKENS.has(record.token) && record.token !== 'COMM') {
        ignored.add(record.token);
      }
    }
  }
  for (const record of document.trailer) {
    ignored.add(record.token);
  }
  return [...ignored].sort();
}

/** Case-insensitive lookup in the core's built-in material catalogue. */
function defaultResolveMaterial(glassName: string): Material | undefined {
  const wanted = glassName.trim().toUpperCase();
  for (const [name, material] of MATERIAL_CATALOG) {
    if (name.toUpperCase() === wanted) {
      return material;
    }
  }
  return undefined;
}
