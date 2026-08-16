import {
  AIR,
  ConstantMaterial,
  MATERIAL_CATALOG,
  ModelGlassMaterial,
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
  /** The material the resolver returned, when it is not the name the file used. */
  resolvedAs?: string;
  /** True when the file described the glass inline rather than naming it. */
  isModelGlass?: boolean;
  /** True when that description gave an index but no dispersion. */
  isNonDispersive?: boolean;
}

export interface ZmxImportResult {
  system: OpticalSystem;
  /** Things the file said that this reader could not honour exactly. */
  warnings: string[];
  /** Every glass the file names, and whether it resolved to a material. */
  glasses: readonly ZmxGlassReference[];
  /**
   * Distinct tokens present in the file that this reader ignored. Almost all of
   * them are annotation rather than prescription — notes, tolerancing, display,
   * multi-configuration and physical-optics settings — so a long list is normal
   * and does not by itself mean the imported system is wrong. Anything ignored
   * that *would* change the traced result is additionally reported in
   * {@link warnings}; see {@link UNMODELLED_SURFACE_TOKENS}.
   */
  ignoredTokens: readonly string[];
  /** The raw parsed document, for callers needing data this mapping drops. */
  document: ZmxDocument;
}

/** Refractive index substituted for an unresolved glass under `allowUnknownGlass`. */
export const UNKNOWN_GLASS_INDEX = 1.5;

/**
 * The name a `GLAS` record carries when the glass is described inline by its
 * index and Abbe number rather than named. It is a literal placeholder, not a
 * catalogue entry, so it is matched on the name rather than on the record's
 * flag columns, whose meaning has not been verified.
 */
export const MODEL_GLASS_NAME = '___BLANK';

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

/**
 * Surface records that carry *geometry* this reader does not model, mapped to a
 * description of what would be lost. These are the only ignored surface tokens
 * that can change where a ray goes, so their presence becomes a warning naming
 * the surface rather than one more entry in `ignoredTokens`. Everything else a
 * surface block can hold — display flags, coating names, scatter data — leaves
 * the traced result untouched.
 */
const UNMODELLED_SURFACE_TOKENS: ReadonlyMap<string, string> = new Map([
  ['CLAP', 'an additional circular clear aperture'],
  ['SQAP', 'a rectangular aperture'],
  ['OBDC', 'a decentred aperture'],
  ['UDAD', 'a user-defined aperture'],
  ['USAP', 'a user-defined aperture'],
  ['PKUP', 'a pickup solve'],
  ['XDAT', 'extra (toroidal/grid) surface data'],
  ['YDAT', 'extra (toroidal/grid) surface data'],
]);

/**
 * `VDXN`/`VDYN` decentre the pupil per field, `VCXN`/`VCYN` compress it and
 * `VANN` rotates it. All-zero — the usual case — means no vignetting, so only
 * a non-zero factor is worth reporting.
 */
const VIGNETTING_TOKENS = ['VDXN', 'VDYN', 'VCXN', 'VCYN', 'VANN'];

/** Zemax's standard environment, which the catalogue indices already assume. */
const STANDARD_TEMPERATURE_C = 20;
const STANDARD_PRESSURE_ATM = 1;

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
  requireParaxialSurfacesInAir(surfaces);
  warnHeaderSettings(document, warnings);
  warnGlassSubstitutions(glasses, warnings);
  warnModelGlasses(glasses, warnings);

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
  if (surfaceType !== 'STANDARD' && surfaceType !== 'PARAXIAL') {
    throw new ZmxImportError(
      `Surface ${number} is TYPE ${surfaceType}; only STANDARD and PARAXIAL surfaces are supported so far.`,
    );
  }
  const isParaxial = surfaceType === 'PARAXIAL';

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
  const type = isObject ? 'OBJECT' : isImage ? 'IMAGE' : isParaxial ? 'PARAXIAL' : 'STANDARD';

  // A PARAXIAL object or image surface is a contradiction: those two ends of the
  // system record rays, they do not bend them.
  if (isParaxial && (isObject || isImage)) {
    throw new ZmxImportError(
      `Surface ${number} is TYPE PARAXIAL but is the ${isObject ? 'object' : 'image'} surface.`,
    );
  }

  warnUnmodelledGeometry(records, number, context.warnings);

  let isStop = hasRecord(records, 'STOP');
  if (isStop && type !== 'STANDARD' && type !== 'PARAXIAL') {
    context.warnings.push(`Surface ${number} is marked STOP but is the ${type} surface; ignoring the stop.`);
    isStop = false;
  }

  if (type === 'PARAXIAL') {
    return new Surface({
      id: `surf-${number}`,
      type,
      focalLength: readParaxialFocalLength(records, number),
      thickness,
      semiDiameter,
      material: readMaterial(records, number, context),
      isStop,
      comment: readComment(records),
    });
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

/**
 * Focal length of a PARAXIAL surface, written as `PARM 1 <focal length>`.
 *
 * `PARM 2` is the OPD mode, which selects how the surface reports optical path;
 * it does not move a ray, so it is left to `ignoredTokens`. Any other parameter
 * on a paraxial surface is unverified, and is refused rather than guessed at.
 */
function readParaxialFocalLength(records: readonly ZmxRecord[], surfaceNumber: number): number {
  let focalLength: number | undefined;
  for (const record of findRecords(records, 'PARM')) {
    const parameter = numericValue(record.values[0]);
    if (parameter === 1) {
      focalLength = numericValue(record.values[1]);
    } else if (parameter !== 2) {
      throw new ZmxImportError(
        `Surface ${surfaceNumber} is TYPE PARAXIAL with an unrecognised PARM ${record.values[0]}; ` +
          'only PARM 1 (focal length) and PARM 2 (OPD mode) are understood.',
      );
    }
  }

  if (focalLength === undefined) {
    throw new ZmxImportError(
      `Surface ${surfaceNumber} is TYPE PARAXIAL but carries no PARM 1 record giving its focal length.`,
    );
  }
  if (!Number.isFinite(focalLength) || focalLength === 0) {
    throw new ZmxImportError(
      `Surface ${surfaceNumber} is TYPE PARAXIAL with a focal length of ${focalLength}, which has no meaning.`,
    );
  }
  return focalLength;
}

/**
 * Refuses a paraxial surface that does not sit in air on both sides.
 *
 * A paraxial surface's power is φ = 1/f, so what its focal length means in a
 * medium of index n depends on whether the file quotes 1/φ or n'/φ. The two
 * agree in air, which is how ideal-lens placeholders are used in practice, and
 * the format has no specification to settle the other case — so refuse it
 * rather than pick a convention and be silently wrong.
 */
function requireParaxialSurfacesInAir(surfaces: readonly Surface[]): void {
  for (let index = 0; index < surfaces.length; index += 1) {
    if (surfaces[index]!.type !== 'PARAXIAL') {
      continue;
    }
    const before = surfaces[index - 1]!.material;
    const after = surfaces[index]!.material;
    if (before !== AIR || after !== AIR) {
      throw new ZmxImportError(
        `Surface ${index} is TYPE PARAXIAL but is immersed in glass (${before.name} → ${after.name}); ` +
          'the meaning of its focal length outside air is not established for this format.',
      );
    }
  }
}

/**
 * Reports surface records that describe geometry outside the model. Dropping
 * these changes the trace, so they must not disappear into `ignoredTokens`.
 */
function warnUnmodelledGeometry(
  records: readonly ZmxRecord[],
  surfaceNumber: number,
  warnings: string[],
): void {
  for (const [token, description] of UNMODELLED_SURFACE_TOKENS) {
    if (hasRecord(records, token)) {
      warnings.push(
        `Surface ${surfaceNumber} has a ${token} record (${description}), which this reader does not model; ` +
          'the surface uses its DIAM semi-diameter alone.',
      );
    }
  }
}

/**
 * Reports header settings that would change how rays are launched or how glass
 * indices are evaluated. Each is only worth a warning when it departs from the
 * value that means "no effect", which is what nearly every file carries.
 */
function warnHeaderSettings(document: ZmxDocument, warnings: string[]): void {
  const vignetting = VIGNETTING_TOKENS.filter((token) =>
    readFieldValues(document, token).some((value) => value !== 0),
  );
  if (vignetting.length > 0) {
    warnings.push(
      `Vignetting factors are set (${vignetting.join(', ')}) but are not modelled; off-axis fields ` +
        'will be traced through the full pupil, so they will look worse than the design intends.',
    );
  }

  const rayAiming = numericValue(firstValue(document.header, 'RAIM'));
  if (rayAiming !== undefined && rayAiming !== 0) {
    warnings.push(
      `The file requests ray aiming (RAIM ${rayAiming}); rays here are aimed paraxially, so rays near ` +
        'the pupil edge can be clipped at the stop.',
    );
  }

  const environment = findRecord(document.header, 'ENVD');
  if (environment) {
    const temperature = numericValue(environment.values[0]);
    const pressure = numericValue(environment.values[1]);
    if (
      (temperature !== undefined && temperature !== STANDARD_TEMPERATURE_C) ||
      (pressure !== undefined && pressure !== STANDARD_PRESSURE_ATM)
    ) {
      warnings.push(
        `ENVD gives a non-standard environment (${temperature} °C, ${pressure} atm); indices are used as ` +
          `published, at ${STANDARD_TEMPERATURE_C} °C and ${STANDARD_PRESSURE_ATM} atm.`,
      );
    }
  }
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
  const glass = findRecord(records, 'GLAS');
  const glassName = glass?.values[0];
  if (glass === undefined || glassName === undefined) {
    return AIR;
  }

  if (glassName === MODEL_GLASS_NAME) {
    return readModelGlass(glass, surfaceNumber, context);
  }

  const material = context.resolve(glassName);
  if (material) {
    // A resolver may answer with a different glass — a catalogue substituting a
    // modern equivalent for an obsolete name, say. That is an approximation the
    // caller has to know about, so it is reported rather than left implicit.
    const substituted = !sameGlassName(glassName, material.name);
    context.glasses.push({
      name: glassName,
      surfaceNumber,
      resolved: true,
      ...(substituted ? { resolvedAs: material.name } : {}),
    });
    return material;
  }
  context.glasses.push({ name: glassName, surfaceNumber, resolved: false });

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

/**
 * Reads a model glass: one the file describes by its index and Abbe number
 * instead of naming, which is how a design taken from a patent specifies glass.
 *
 * Only `nd` and `Vd` are read. The record's remaining columns are left alone
 * because their meaning has not been verified — one file in the sample corpus
 * carries a stray value in the column where ΔPg,F might live, and it is plainly
 * the Abbe number of an unrelated glass left behind by an edit. Reading it as a
 * partial dispersion would quietly distort the colour correction, so the glass
 * is built on the normal line instead.
 */
function readModelGlass(
  glass: ZmxRecord,
  surfaceNumber: number,
  context: SurfaceContext,
): Material {
  const nd = numericValue(glass.values[3]);
  const abbeNumber = numericValue(glass.values[4]);

  if (nd === undefined || nd <= 0 || abbeNumber === undefined || abbeNumber < 0) {
    throw new ZmxImportError(
      `Surface ${surfaceNumber} has a model glass with no usable index and Abbe number ` +
        `(read "${glass.values.slice(0, 5).join(' ')}").`,
    );
  }

  // Vd = 0 cannot be an Abbe number — it would mean infinite dispersion — so it
  // is the file saying the glass has none: an index and nothing more.
  if (abbeNumber === 0) {
    const name = `${MODEL_GLASS_NAME} n=${nd.toFixed(4)}`;
    context.glasses.push({
      name,
      surfaceNumber,
      resolved: true,
      isModelGlass: true,
      isNonDispersive: true,
    });
    return new ConstantMaterial(name, nd);
  }

  const name = `${MODEL_GLASS_NAME} ${nd.toFixed(4)}/${abbeNumber.toFixed(2)}`;
  context.glasses.push({ name, surfaceNumber, resolved: true, isModelGlass: true });
  return new ModelGlassMaterial(name, nd, abbeNumber);
}

/**
 * A resolver may answer with a different glass — a catalogue substituting a
 * modern equivalent for an obsolete name, say. That is an approximation the
 * caller has to know about, so it is reported once per glass rather than left
 * implicit or repeated for every surface the glass appears on.
 */
/**
 * Model glasses are an approximation of a real melt, so the import says how many
 * it built rather than letting them pass for catalogue glass. Reported once
 * rather than per surface — a file can carry dozens.
 */
function warnModelGlasses(glasses: readonly ZmxGlassReference[], warnings: string[]): void {
  const model = glasses.filter((glass) => glass.isModelGlass);
  if (model.length === 0) {
    return;
  }

  const surfaces = model.length === 1 ? '1 surface' : `${model.length} surfaces`;
  warnings.push(
    `${surfaces} use a model glass: an index and Abbe number rather than a named glass. ` +
      'Indices are approximated to about 1e-4 in the visible, which is fine for layout and ' +
      'first-order work but not for judging colour correction.',
  );

  const nonDispersive = model.filter((glass) => glass.isNonDispersive);
  if (nonDispersive.length > 0) {
    warnings.push(
      `${nonDispersive.length} of those give an index but no dispersion (Vd = 0), so they are ` +
        'traced as non-dispersive: the design will show no chromatic aberration from them.',
    );
  }
}

function warnGlassSubstitutions(glasses: readonly ZmxGlassReference[], warnings: string[]): void {
  const substitutions = new Map<string, string>();
  for (const glass of glasses) {
    if (glass.resolvedAs) {
      substitutions.set(glass.name, glass.resolvedAs);
    }
  }
  for (const [name, resolvedAs] of substitutions) {
    warnings.push(
      `Glass "${name}" is not in the catalogue and was traced as "${resolvedAs}"; ` +
        'it is a substitute, not the same glass.',
    );
  }
}

/** Files spell the same glass `N-BK7`, `N BK7` or `nbk7`; none of those is a substitution. */
function sameGlassName(a: string, b: string): boolean {
  const normalize = (name: string): string => name.trim().toUpperCase().replace(/[\s_-]+/g, '');
  return normalize(a) === normalize(b);
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
    // PARM carries the focal length on a paraxial surface and something
    // unverified everywhere else, so it counts as handled only there.
    const isParaxial = firstValue(block.records, 'TYPE')?.toUpperCase() === 'PARAXIAL';
    for (const record of block.records) {
      if (record.token === 'COMM' || HANDLED_SURFACE_TOKENS.has(record.token)) {
        continue;
      }
      if (record.token === 'PARM' && isParaxial) {
        continue;
      }
      ignored.add(record.token);
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
