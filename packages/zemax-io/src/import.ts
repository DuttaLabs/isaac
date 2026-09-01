import {
  AIR,
  ConstantMaterial,
  MATERIAL_CATALOG,
  ModelGlassMaterial,
  OpticalSystem,
  STOP_CAPABLE_SURFACE_TYPES,
  Surface,
  type Aperture,
  type ApertureType,
  type Field,
  type LinearUnit,
  type CoordinateTransform,
  isCircularAperture,
  type ApertureKind,
  type Material,
  type SurfaceApertureConfig,
  type SurfaceType,
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
  /** Things the file said that this reader could not honor exactly. */
  warnings: string[];
  /** Every glass the file names, and whether it resolved to a material. */
  glasses: readonly ZmxGlassReference[];
  /**
   * Distinct tokens present in the file that this reader ignored. Almost all of
   * them are annotation rather than prescription — notes, tolerancing, display,
   * multi-configuration and physical-optics settings — so a long list is normal
   * and does not by itself mean the imported system is wrong. Anything ignored
   * that *would* change the traced result is additionally reported in
   * {@link warnings}; see {@link UNMODELED_SURFACE_TOKENS}.
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
 * catalog entry, so it is matched on the name rather than on the record's
 * flag columns, whose meaning has not been verified.
 */
export const MODEL_GLASS_NAME = '___BLANK';

/**
 * The glass name Zemax uses for a reflecting surface. It is not a material at
 * all: it says the surface turns the light around and leaves it in the medium it
 * arrived in, which is why the medium after a mirror never appears in the file.
 */
export const MIRROR_GLASS_NAME = 'MIRROR';

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
const HANDLED_SURFACE_TOKENS = new Set([
  'TYPE',
  'CURV',
  'DISZ',
  'DIAM',
  'GLAS',
  'STOP',
  'CONI',
  'CLAP',
  'OBSC',
  'SPID',
  'SQAP',
  'SQOB',
  'ELAP',
  'ELOB',
  'FLAP',
  'OBDC',
]);

/**
 * Zemax surface types this reader maps onto the model. Everything else is
 * refused by name rather than approximated as a sphere.
 */
const SUPPORTED_ZMX_TYPES = new Set(['STANDARD', 'PARAXIAL', 'EVENASPH', 'TILTSURF', 'COORDBRK']);

/**
 * Surface records that carry *geometry* this reader does not model, mapped to a
 * description of what would be lost. These are the only ignored surface tokens
 * that can change where a ray goes, so their presence becomes a warning naming
 * the surface rather than one more entry in `ignoredTokens`. Everything else a
 * surface block can hold — display flags, coating names, scatter data — leaves
 * the traced result untouched.
 */
/**
 * The **surface** aperture records this reader models, in the order a surface
 * carrying more than one is resolved: circular before floating, because a stated
 * radius is more specific than "whatever the semi-diameter is".
 *
 * Not to be confused with `APERTURE_TOKENS` below, which is the *system*
 * aperture — `ENPD`, `FNUM` and friends. Zemax keeps the same two meanings apart
 * by calling one a system aperture and the other a surface aperture, and so does
 * this file.
 */
const SURFACE_APERTURE_TOKENS = [
  'CLAP',
  'OBSC',
  'SPID',
  'SQAP',
  'SQOB',
  'ELAP',
  'ELOB',
  'FLAP',
] as const;

/** Which kind each record names. Verified against Chapter 29's keyword table. */
const APERTURE_KIND_OF: Record<string, ApertureKind> = {
  CLAP: 'CIRCULAR',
  OBSC: 'CIRCULAR_OBSCURATION',
  SPID: 'SPIDER',
  SQAP: 'RECTANGULAR',
  SQOB: 'RECTANGULAR_OBSCURATION',
  ELAP: 'ELLIPTICAL',
  ELOB: 'ELLIPTICAL_OBSCURATION',
  FLAP: 'FLOATING',
};

/**
 * What this reader does with each record type, for anything that wants to *show*
 * a file rather than import one.
 *
 * Exported so the editor's highlighting is the reader's own answer rather than a
 * second list that drifts from it: a token colored as prescription is one this
 * package genuinely interprets, and one colored as annotation is one it skips.
 * Adding a token to the sets above therefore changes the colors too, which is
 * the only way the two can be kept honest.
 */
export type ZmxTokenRole =
  /** Read, and it shapes the system: `CURV`, `GLAS`, `CLAP`. */
  | 'prescription'
  /** Read, and it describes the system as a whole: `ENPD`, `WAVM`, `UNIT`. */
  | 'system'
  /** Structure rather than content: where a surface starts, what type it is. */
  | 'structure'
  /** Skipped, and its absence would change the trace — warned about per surface. */
  | 'unmodeled'
  /** Skipped, and nothing optical depends on it: notes, tolerancing, display. */
  | 'annotation';

/** Records that mark structure rather than carry a value. */
const STRUCTURE_TOKENS = new Set(['SURF', 'MODE', 'TYPE', 'NAME', 'VERS', 'UNIT']);

/** What role a record's token plays, for a reader or a highlighter. */
export function zmxTokenRole(token: string): ZmxTokenRole {
  const upper = token.toUpperCase();
  if (STRUCTURE_TOKENS.has(upper)) {
    return 'structure';
  }
  if (HANDLED_SURFACE_TOKENS.has(upper) || upper === 'PARM') {
    return 'prescription';
  }
  if (HANDLED_HEADER_TOKENS.has(upper)) {
    return 'system';
  }
  return UNMODELED_SURFACE_TOKENS.has(upper) ? 'unmodeled' : 'annotation';
}

/**
 * Ignored *surface* records that would move a ray. Their presence is warned
 * about per surface, unlike the annotation the rest of `ignoredTokens` holds.
 *
 * `SCBD` is OpticStudio's Tilt/Decenter tab — a tilt and decenter carried as an
 * attribute *of a surface* rather than written as coordinate breaks around it,
 * and the manual in `SupportingMaterial/` predates it. Ignoring it silently is
 * the worst case this reader has: 7 of the 471 sample files carry one, and a
 * fold mirror whose 45° is dropped imports as a flat plate that traces
 * perfectly and is the wrong system.
 */
const UNMODELED_SURFACE_TOKENS: ReadonlyMap<string, string> = new Map([
  ['SCBD', 'a tilt/decenter on the surface itself'],
  ['UDAD', 'a user-defined aperture'],
  ['USAP', 'a user-defined aperture'],
  ['PKUP', 'a pickup solve'],
  ['XDAT', 'extra (toroidal/grid) surface data'],
  ['YDAT', 'extra (toroidal/grid) surface data'],
]);

/**
 * `VDXN`/`VDYN` decenter the pupil per field, `VCXN`/`VCYN` compress it and
 * `VANN` rotates it. All-zero — the usual case — means no vignetting, so only
 * a non-zero factor is worth reporting.
 */
const VIGNETTING_TOKENS = ['VDXN', 'VDYN', 'VCXN', 'VCYN', 'VANN'];

/** Zemax's standard environment, which the catalog indices already assume. */
const STANDARD_TEMPERATURE_C = 20;
const STANDARD_PRESSURE_ATM = 1;

/** Aperture tokens, mapped to the core's aperture types. */
const APERTURE_TOKENS: ReadonlyMap<string, ApertureType> = new Map([
  ['ENPD', 'ENTRANCE_PUPIL_DIAMETER'],
  ['FNUM', 'IMAGE_SPACE_FNUM'],
  ['OBNA', 'OBJECT_SPACE_NA'],
  ['FLOA', 'FLOAT_BY_STOP'],
]);

/**
 * `UNIT`'s first value. The corpus spells meters `METER`, not `M` — 3 of the 471
 * sample files do, and until this table said so they imported as millimetres
 * with a warning, which mislabels every length in the UI by a factor of a
 * thousand. `M` is kept as a tolerant alias rather than a verified spelling.
 */
const UNITS: ReadonlyMap<string, LinearUnit> = new Map([
  ['MM', 'mm'],
  ['CM', 'cm'],
  ['METER', 'm'],
  ['METERS', 'm'],
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
    throw new ZmxImportError(
      `Only sequential (MODE SEQ) files are supported; this file is MODE ${mode}.`,
    );
  }

  if (document.surfaces.length < 2) {
    throw new ZmxImportError(
      `A lens file needs at least an object and an image surface; found ${document.surfaces.length}.`,
    );
  }
  if (document.surfaces[0]!.number !== 0) {
    warnings.push(`Surface list starts at SURF ${document.surfaces[0]!.number}, not SURF 0.`);
  }

  const surfaces = adoptMirrorMedia(
    document.surfaces.map((block, index) =>
      toSurface(block, index, document.surfaces.length, { resolve, options, warnings, glasses }),
    ),
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
  if (!SUPPORTED_ZMX_TYPES.has(surfaceType)) {
    throw new ZmxImportError(
      `Surface ${number} is TYPE ${surfaceType}; only ` +
        `${[...SUPPORTED_ZMX_TYPES].join(', ')} surfaces are supported so far.`,
    );
  }
  const isParaxial = surfaceType === 'PARAXIAL';
  const isEvenAsphere = surfaceType === 'EVENASPH';
  // Zemax spells this `COORDBRK` and calls it a **coordinate break**. The model
  // calls the same thing a COORDINATE_TRANSFORM — what it actually does, and the
  // name 3-D graphics gives it. This is where the two vocabularies meet, so the
  // file's word survives here and nowhere else.
  const isCoordinateTransform = surfaceType === 'COORDBRK';
  // Zemax's `TILTSURF`: a plane at an angle, its two parameters being the
  // tangents of that angle about x and y.
  const isTiltedSurface = surfaceType === 'TILTSURF';

  const conic = numericValue(firstValue(records, 'CONI')) ?? 0;
  if (!Number.isFinite(conic)) {
    throw new ZmxImportError(`Surface ${number} has a CONI of ${conic}, which is not a shape.`);
  }

  const curvature = numericValue(firstValue(records, 'CURV')) ?? 0;
  const radius = curvature === 0 ? Infinity : 1 / curvature;

  const thickness = readThickness(records, number);
  // DIAM 0 means Zemax has no fixed aperture on the surface, not a zero aperture.
  const diameter = numericValue(firstValue(records, 'DIAM')) ?? 0;
  const semiDiameter = diameter > 0 ? diameter : Infinity;

  const isObject = index === 0;
  const isImage = index === count - 1;
  const type: SurfaceType = isObject
    ? 'OBJECT'
    : isImage
      ? 'IMAGE'
      : isParaxial
        ? 'PARAXIAL'
        : isEvenAsphere
          ? 'EVEN_ASPHERE'
          : isTiltedSurface
            ? 'TILTED'
            : isCoordinateTransform
              ? 'COORDINATE_TRANSFORM'
              : 'STANDARD';

  // An aspheric object or image surface is not refused — a curved detector is a
  // real thing — but the polynomial belongs to a surface that bends rays, and
  // giving it to one that only records them would misreport the file.
  if (isEvenAsphere && (isObject || isImage)) {
    throw new ZmxImportError(
      `Surface ${number} is TYPE EVENASPH but is the ${isObject ? 'object' : 'image'} surface.`,
    );
  }

  // A PARAXIAL object or image surface is a contradiction: those two ends of the
  // system record rays, they do not bend them.
  if (isParaxial && (isObject || isImage)) {
    throw new ZmxImportError(
      `Surface ${number} is TYPE PARAXIAL but is the ${isObject ? 'object' : 'image'} surface.`,
    );
  }

  // A tilted *object or image* plane is exactly what this surface type is for —
  // Zemax's own manual says so — and it is the one thing Isaac cannot yet
  // express, because `OBJECT` and `IMAGE` are surface *types* here rather than
  // positions in the list, so a surface cannot be both. Refused with the reason
  // rather than imported as an untilted plane, which would be the wrong lens
  // quietly.
  if (isTiltedSurface && (isObject || isImage)) {
    throw new ZmxImportError(
      `Surface ${number} is TYPE TILTSURF but is the ${isObject ? 'object' : 'image'} surface; ` +
        'Isaac models those two as surface types rather than as positions, so it cannot yet tilt them.',
    );
  }

  // The manual is explicit that the object surface can never be a coordinate
  // break; an image one is the same contradiction at the other end, since the
  // system has to end somewhere a ray can land.
  if (isCoordinateTransform && (isObject || isImage)) {
    throw new ZmxImportError(
      `Surface ${number} is TYPE COORDBRK but is the ${isObject ? 'object' : 'image'} surface; ` +
        'a coordinate transform is a change of frame, not a place a ray can land.',
    );
  }

  warnUnmodeledGeometry(records, number, context.warnings);

  // `GLAS MIRROR` names no material: it makes the surface reflective and leaves
  // the medium alone. The medium it leaves alone is the one before the surface,
  // which is not known here — surfaces are built independently — so AIR stands
  // in and `adoptMirrorMedia` replaces it once the whole list exists.
  const reflective = isMirror(records);
  if (reflective && (isObject || isImage)) {
    throw new ZmxImportError(
      `Surface ${number} is GLAS MIRROR but is the ${isObject ? 'object' : 'image'} surface; ` +
        'those two record rays rather than reflecting them.',
    );
  }

  let isStop = hasRecord(records, 'STOP');
  if (isStop && !STOP_CAPABLE_SURFACE_TYPES.includes(type)) {
    context.warnings.push(
      `Surface ${number} is marked STOP but is the ${type} surface; ignoring the stop.`,
    );
    isStop = false;
  }

  if (type === 'COORDINATE_TRANSFORM') {
    // No radius, no conic, no aperture: a transform has no shape to carry them, and
    // the model refuses them. Files write `CURV 0` and `DIAM 0` here anyway.
    // The medium is filled in by `adoptMirrorMedia`, which carries the previous
    // surface's material forward — a transform cannot be a boundary between media.
    return new Surface({
      id: `surf-${number}`,
      type,
      coordinateTransform: readCoordinateTransform(records, number),
      thickness,
      isStop,
      comment: readComment(records),
    });
  }

  if (type === 'TILTED') {
    return new Surface({
      id: `surf-${number}`,
      type,
      tiltTangents: readTiltTangents(records, number),
      thickness,
      semiDiameter,
      aperture: readSurfaceAperture(records, number, context),
      material: reflective ? AIR : readMaterial(records, number, context),
      reflective,
      isStop,
      comment: readComment(records),
    });
  }

  if (type === 'PARAXIAL') {
    return new Surface({
      id: `surf-${number}`,
      type,
      focalLength: readParaxialFocalLength(records, number),
      thickness,
      semiDiameter,
      aperture: readSurfaceAperture(records, number, context),
      material: readMaterial(records, number, context),
      isStop,
      comment: readComment(records),
    });
  }

  return new Surface({
    id: `surf-${number}`,
    type,
    radius,
    conic,
    ...(type === 'EVEN_ASPHERE'
      ? { asphericCoefficients: readAsphericCoefficients(records, number) }
      : {}),
    thickness,
    semiDiameter,
    aperture: readSurfaceAperture(records, number, context),
    material: reflective ? AIR : readMaterial(records, number, context),
    reflective,
    isStop,
    comment: readComment(records),
  });
}

/** True when the surface's `GLAS` record names Zemax's reflector rather than a glass. */
function isMirror(records: readonly ZmxRecord[]): boolean {
  const glassName = findRecord(records, 'GLAS')?.values[0];
  return glassName !== undefined && glassName.trim().toUpperCase() === MIRROR_GLASS_NAME;
}

/**
 * Gives every mirror the medium of the surface before it.
 *
 * A file never states it: `GLAS MIRROR` says only "reflect", and the medium on
 * the far side is whatever the light was already in. That reads naturally down
 * the surface list — the Mangin mirror in OpticStudio's samples is a BK7 surface,
 * then `GLAS MIRROR`, then a surface with no glass at all, and the mirror's own
 * medium has to be the BK7 for the light to come back out through it. Left as
 * AIR, that design would trace as though the glass vanished on the way back.
 *
 * Two mirrors in a row is not a special case: the loop runs forward, so the
 * second one adopts the medium the first one has already been given.
 */
function adoptMirrorMedia(surfaces: readonly Surface[]): Surface[] {
  const resolved = [...surfaces];
  for (let index = 1; index < resolved.length; index += 1) {
    const surface = resolved[index]!;
    // A coordinate transform is in the same position as a mirror and for the same
    // reason: it names no glass, because it cannot be a boundary between two
    // media. Zemax shows "-" in its glass column to say so. Both carry the
    // medium of the surface before them, and the model refuses anything else.
    if (surface.reflective || surface.type === 'COORDINATE_TRANSFORM') {
      resolved[index] = surface.with({ material: resolved[index - 1]!.material });
    }
  }
  return resolved;
}

/**
 * The six numbers of a COORDBRK surface, written as `PARM 1` through `PARM 6`:
 * decenter x and y, tilt about x, y and z, and the order flag.
 *
 * The tilts are degrees and the decenters lens units, both straight from the
 * file. `PARM 6` is a flag, not a quantity: Zemax reads *any* non-zero value as
 * "tilt first", so it is compared that way rather than tested against 1.
 *
 * A missing column is a zero, which is what a file omitting one means, but an
 * unrecognized `PARM` is refused — on this surface type the column numbers carry
 * the whole meaning, and one that is not among the six is not something to guess
 * at. That is the same rule the PARAXIAL and EVENASPH readers follow.
 */
/**
 * The surface's aperture, if it has one.
 *
 * Three records, all verified against Chapter 29's keyword table and the sample
 * corpus: `CLAP min max` is a circular clear aperture, `OBSC min max` a circular
 * obscuration, and `FLAP` a floating one whose radius is the semi-diameter.
 * `OBDC xdec ydec` decenters whichever of them the surface has — one record
 * serving all three, which is why the decenter lives on the aperture here too.
 *
 * Files write a **third** value on `CLAP`/`OBSC`/`FLAP` that the manual does not
 * document; it is `0` in all 820 records in the corpus, so it is left alone
 * rather than guessed at, and written back as the `0` every file carries.
 *
 * A surface may carry more than one aperture record — Zemax allows an aperture
 * and an obscuration together. Only the first is taken, and the rest are
 * reported, rather than silently keeping whichever happened to be last.
 */
function readSurfaceAperture(
  records: readonly ZmxRecord[],
  number: number,
  context: SurfaceContext,
): SurfaceApertureConfig | undefined {
  const found = SURFACE_APERTURE_TOKENS.map((token) => ({
    token,
    record: findRecord(records, token),
  })).filter((entry) => entry.record !== undefined);
  if (found.length === 0) {
    return undefined;
  }
  if (found.length > 1) {
    context.warnings.push(
      `Surface ${number} carries ${found.length} aperture records ` +
        `(${found.map((entry) => entry.token).join(', ')}); only the ${found[0]!.token} is modeled.`,
    );
  }
  const { token, record } = found[0]!;
  const decenter = findRecord(records, 'OBDC');
  const decenterX = numericValue(decenter?.values[0]) ?? 0;
  const decenterY = numericValue(decenter?.values[1]) ?? 0;

  if (token === 'FLAP') {
    // Its radius is the semi-diameter, so the numbers the file writes here are
    // the value that floated, not a second definition of it.
    return { kind: 'FLOATING', decenterX, decenterY };
  }

  const kind = APERTURE_KIND_OF[token]!;
  const first = numericValue(record!.values[0]) ?? 0;
  const second = numericValue(record!.values[1]) ?? 0;

  if (kind === 'SPIDER') {
    // **`SPID` is `width numarms`, which is the reverse of what the manual
    // says.** Chapter 29 gives it as `SPID numarms width`, and this is the one
    // place in the corpus where its argument *order* is wrong: the sample file
    // `Schmidt-Cassegrain spider obscuration.zmx` writes `SPID 2 3`, and
    // OpticStudio shows that surface as **3 arms, 2 wide**. Read the manual's
    // way it would be one arm two units wide, and the file `sc_spatial3.zmx`
    // would have a single arm three units across a surface whose semi-diameter
    // is 2 — an arm wider than the aperture it crosses.
    if (first <= 0 || !Number.isInteger(second) || second < 1) {
      context.warnings.push(
        `Surface ${number} has SPID ${first} ${second}, which describes no spider; ignoring it.`,
      );
      return undefined;
    }
    return { kind, armWidth: first, armCount: second, decenterX, decenterY };
  }

  if (!isCircularAperture(kind)) {
    // `SQAP xwid ywid` and `ELAP xwid ywid` are **half**-widths, which the
    // corpus settles rather than the manual: `SQAP 25 25` sits on a surface
    // whose semi-diameter is 35.36 — exactly 25√2, the circle circumscribing
    // that rectangle. Reading them as full widths would halve every such
    // aperture and still trace.
    if (first <= 0 || second <= 0 || !Number.isFinite(first) || !Number.isFinite(second)) {
      context.warnings.push(
        `Surface ${number} has ${token} ${first} ${second}, an aperture of no extent; ignoring it.`,
      );
      return undefined;
    }
    return { kind, halfWidthX: first, halfWidthY: second, decenterX, decenterY };
  }

  const minRadius = first;
  const maxRadius = second;
  // An aperture of zero radius has no extent, which is the literal reading of a
  // record left at its defaults: one file in the corpus carries `OBSC 0 0 0`,
  // plainly a leftover from an edit. Saying so beats both refusing to open the
  // file and honoring it — an obscuration of radius zero obscures nothing, and a
  // clear aperture of radius zero would pass nothing at all.
  if (maxRadius === 0) {
    context.warnings.push(
      `Surface ${number} has ${token} ${minRadius} ${maxRadius}, an aperture of no extent; ignoring it.`,
    );
    return undefined;
  }
  if (!Number.isFinite(minRadius) || !Number.isFinite(maxRadius) || maxRadius <= minRadius) {
    throw new ZmxImportError(
      `Surface ${number} has ${token} ${minRadius} ${maxRadius}, which bounds no ring.`,
    );
  }
  return { kind, minRadius, maxRadius, decenterX, decenterY };
}

function readCoordinateTransform(
  records: readonly ZmxRecord[],
  surfaceNumber: number,
): CoordinateTransform {
  const values = new Map<number, number>();
  for (const record of findRecords(records, 'PARM')) {
    const column = numericValue(record.values[0]);
    const value = numericValue(record.values[1]) ?? 0;
    if (column === undefined || !Number.isInteger(column) || column < 1 || column > 6) {
      throw new ZmxImportError(
        `Surface ${surfaceNumber} is TYPE COORDBRK with an unrecognized PARM ${record.values[0]}; ` +
          'only PARM 1 through 6 (the decenters, tilts and order flag) are understood.',
      );
    }
    if (!Number.isFinite(value)) {
      throw new ZmxImportError(
        `Surface ${surfaceNumber} has a COORDBRK PARM ${column} of ${record.values[1]}.`,
      );
    }
    values.set(column, value);
  }

  return {
    decenterX: values.get(1) ?? 0,
    decenterY: values.get(2) ?? 0,
    tiltXDeg: values.get(3) ?? 0,
    tiltYDeg: values.get(4) ?? 0,
    tiltZDeg: values.get(5) ?? 0,
    tiltFirst: (values.get(6) ?? 0) !== 0,
  };
}

/**
 * The eight aspheric coefficients of an EVENASPH surface, written as
 * `PARM 1 α₁` … `PARM 8 α₈`.
 *
 * **`PARM 1` is the coefficient on r², not r⁴.** Chapter 14 of the 2000 manual
 * gives the sag as `α₁r² + α₂r⁴ + … + α₈r¹⁶` and its parameter table maps the
 * eight columns straight onto α₁…α₈, so the series starts at the second power.
 * Reading it as r⁴ would shift every term by one power: a design would still
 * trace, and would still look like a lens, while being the wrong lens. Two of
 * the sixteen even-asphere surfaces in OpticStudio's own samples carry a
 * non-zero α₁, so the off-by-one would not even show up as an obvious break.
 *
 * A parameter outside 1–8 is refused rather than guessed at, on the same footing
 * as an unrecognized PARM on a paraxial surface.
 */
function readAsphericCoefficients(records: readonly ZmxRecord[], surfaceNumber: number): number[] {
  const coefficients: number[] = [];
  for (const record of findRecords(records, 'PARM')) {
    const parameter = numericValue(record.values[0]);
    if (parameter === undefined || !Number.isInteger(parameter) || parameter < 1 || parameter > 8) {
      throw new ZmxImportError(
        `Surface ${surfaceNumber} is TYPE EVENASPH with an unrecognized PARM ${record.values[0]}; ` +
          'only PARM 1 through 8 (the coefficients on r² through r¹⁶) are understood.',
      );
    }
    const coefficient = numericValue(record.values[1]) ?? 0;
    if (!Number.isFinite(coefficient)) {
      throw new ZmxImportError(
        `Surface ${surfaceNumber} has PARM ${parameter} = ${record.values[1]}, which is not a number.`,
      );
    }
    // The columns need not appear in order, and a file may write only the ones
    // it uses; anything unwritten is zero.
    while (coefficients.length < parameter) {
      coefficients.push(0);
    }
    coefficients[parameter - 1] = coefficient;
  }
  return coefficients;
}

/**
 * Focal length of a PARAXIAL surface, written as `PARM 1 <focal length>`.
 *
 * `PARM 2` is the OPD mode, which selects how the surface reports optical path;
 * it does not move a ray, so it is left to `ignoredTokens`. Any other parameter
 * on a paraxial surface is unverified, and is refused rather than guessed at.
 */
/**
 * The two tangents of a `TILTSURF`, from `PARM 1` and `PARM 2`.
 *
 * Chapter 14: "The tilted surface is simply a plane that makes an angle with
 * respect to the x and y axes… uses the first two parameters to define the
 * tangents of the x and y angles." Any *other* parameter there is refused rather
 * than guessed at, exactly as on a paraxial surface — a column whose meaning is
 * unverified is not a column to read.
 *
 * Both default to zero, so a `TILTSURF` with one parameter is a plane tilted
 * about one axis, which is how a wedge is written.
 */
function readTiltTangents(
  records: readonly ZmxRecord[],
  surfaceNumber: number,
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const record of findRecords(records, 'PARM')) {
    const parameter = numericValue(record.values[0]);
    const value = numericValue(record.values[1]) ?? 0;
    if (parameter === 1) {
      x = value;
    } else if (parameter === 2) {
      y = value;
    } else {
      throw new ZmxImportError(
        `Surface ${surfaceNumber} is TYPE TILTSURF with an unrecognized PARM ${record.values[0]}; ` +
          'only PARM 1 and PARM 2, the x and y tangents, are understood.',
      );
    }
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ZmxImportError(
      `Surface ${surfaceNumber} is TYPE TILTSURF with tangents ${x}, ${y}, which describe no plane.`,
    );
  }
  return { x, y };
}

function readParaxialFocalLength(records: readonly ZmxRecord[], surfaceNumber: number): number {
  let focalLength: number | undefined;
  for (const record of findRecords(records, 'PARM')) {
    const parameter = numericValue(record.values[0]);
    if (parameter === 1) {
      focalLength = numericValue(record.values[1]);
    } else if (parameter !== 2) {
      throw new ZmxImportError(
        `Surface ${surfaceNumber} is TYPE PARAXIAL with an unrecognized PARM ${record.values[0]}; ` +
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
function warnUnmodeledGeometry(
  records: readonly ZmxRecord[],
  surfaceNumber: number,
  warnings: string[],
): void {
  for (const [token, description] of UNMODELED_SURFACE_TOKENS) {
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
      `Vignetting factors are set (${vignetting.join(', ')}) but are not modeled; off-axis fields ` +
        'will be traced through the full pupil, so they will look worse than the design intends.',
    );
  }

  // RAIM is `tol type ...`; the leading tol is a dead placeholder (zero in every file seen), so
  // the aiming mode is the *second* value: 0 none, 1 paraxial, 2 real.
  const rayAiming = numericValue(findRecord(document.header, 'RAIM')?.values[1]);
  if (rayAiming !== undefined && rayAiming !== 0) {
    const mode = rayAiming === 1 ? 'paraxial' : rayAiming === 2 ? 'real' : `mode ${rayAiming}`;
    warnings.push(
      `The file requests ${mode} ray aiming (RAIM ${rayAiming}); rays here are aimed paraxially, so ` +
        'rays near the pupil edge can be clipped at the stop.',
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
    // A resolver may answer under a different name — a catalog resolving an
    // obsolete name, which may be the same glass renamed or a different one
    // substituted. Only the resolver knows which, so the difference is reported
    // rather than left implicit.
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
 * partial dispersion would quietly distort the color correction, so the glass
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
 * A resolver may answer under a different name — a catalog resolving an obsolete
 * name, which may be the same glass renamed or a different one substituted for
 * it. This reader cannot tell those apart: `resolveMaterial` hands back a
 * material, not a provenance. So the difference in name is reported once per
 * glass, without claiming which of the two it is.
 */
/**
 * Model glasses are an approximation of a real melt, so the import says how many
 * it built rather than letting them pass for catalog glass. Reported once
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
      'first-order work but not for judging color correction.',
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
      `Glass "${name}" is not in the catalog under that name and was traced as ` +
        `"${resolvedAs}"; that may be the same glass renamed or a different one ` +
        'substituted for it, which the resolver does not say.',
    );
  }
}

/** Files spell the same glass `N-BK7`, `N BK7` or `nbk7`; none of those is a substitution. */
function sameGlassName(a: string, b: string): boolean {
  const normalize = (name: string): string =>
    name
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, '');
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
    warnings.push(`Unrecognized UNIT "${raw}"; assuming millimeters.`);
    return 'mm';
  }
  return unit;
}

/**
 * `WAVM n λ weight` carries wavelengths in micrometers. Files pad the list out
 * to 24 entries, so the count from FTYP decides how many are real.
 */
function readWavelengths(document: ZmxDocument, warnings: string[]): number[] {
  const byNumber = new Map<number, number>();
  for (const record of findRecords(document.header, 'WAVM')) {
    const number = numericValue(record.values[0]);
    const micrometers = numericValue(record.values[1]);
    if (number === undefined || micrometers === undefined || micrometers <= 0) {
      continue;
    }
    byNumber.set(number, micrometers * 1000);
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
    warnings.push(
      'X field points are present but the core models Y fields only; X values were dropped.',
    );
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
    // PARM means the focal length on a paraxial surface and the aspheric
    // coefficients on an even asphere; everywhere else its columns are
    // unverified, so it counts as handled only on those two types.
    const blockType = firstValue(block.records, 'TYPE')?.toUpperCase() ?? 'STANDARD';
    const parmIsRead = blockType === 'PARAXIAL' || blockType === 'EVENASPH';
    for (const record of block.records) {
      if (record.token === 'COMM' || HANDLED_SURFACE_TOKENS.has(record.token)) {
        continue;
      }
      if (record.token === 'PARM' && parmIsRead) {
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

/** Case-insensitive lookup in the core's built-in material catalog. */
function defaultResolveMaterial(glassName: string): Material | undefined {
  const wanted = glassName.trim().toUpperCase();
  for (const [name, material] of MATERIAL_CATALOG) {
    if (name.toUpperCase() === wanted) {
      return material;
    }
  }
  return undefined;
}
