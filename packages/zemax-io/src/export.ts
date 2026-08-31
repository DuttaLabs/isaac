/**
 * Writing a .zmx file: the reader run backwards.
 *
 * It is in two stages for the same reason reading is. {@link systemToZmxDocument}
 * maps an `OpticalSystem` onto raw records, and {@link formatZmxDocument} turns
 * records into text. Nothing is interpreted in the second stage, so a caller
 * that wants to add or replace a record can do it between the two.
 *
 * **What this writes is what Isaac models.** A file that came in through
 * `importZmx` arrived with thirty-odd record types this reader does not
 * interpret — notes, tolerancing, display flags, multi-configuration — and none
 * of them are on `OpticalSystem` to write back out. Exporting an imported file
 * therefore produces the same *lens*, not the same *file*. Keeping the original
 * around and re-emitting its untouched records is a real feature, but it is a
 * different one, and pretending to it here would quietly drop data.
 *
 * Every token written is one of two kinds:
 *
 * - **Prescription** — the geometry, glasses, fields, wavelengths and aperture
 *   the reader interprets. These come from the system.
 * - **Boilerplate** — records every file carries and this reader ignores
 *   (`GFAC`, `RAIM`, `SDMA`, `ROPD`, `PICB`, `POLS`, `GLRS`, …). These are
 *   written at the *no-op* value that the sample corpus overwhelmingly carries:
 *   no apodization, no ray aiming, no vignetting, 20 °C at 1 atm. Leaving them
 *   out would be defensible, but a reader that expects them would then fill in
 *   its own defaults, and those are not knowable from here. Writing the value
 *   that means "nothing unusual" is the one choice that cannot surprise.
 *
 * Verified against Chapter 29 of the 2000 Zemax manual (the keyword table and
 * its "minimum ZMX file") and against the record forms and orderings actually
 * used by the 471 OpticStudio sample files. Where the two disagree the corpus
 * wins, because the manual predates the format's later additions: it documents
 * fields as `XFLD`/`YFLD` and wavelengths as `WAVL`, and no file in the corpus
 * writes either — they are `XFLN`/`YFLN` and `WAVM`, which is also what this
 * package reads.
 */

import {
  ModelGlassMaterial,
  isCircularAperture,
  type ApertureKind,
  type LinearUnit,
  type Material,
  type OpticalSystem,
  type Surface,
} from '@isaac/optical-core';
import type { ZmxDocument, ZmxRecord, ZmxSurfaceBlock } from './document.ts';
import { MIRROR_GLASS_NAME, MODEL_GLASS_NAME } from './import.ts';

/** Thrown when a system holds something the format cannot express. */
export class ZmxExportError extends Error {
  public override name = 'ZmxExportError';
}

export interface ZmxExportResult {
  /** The .zmx text. */
  text: string;
  /**
   * Things about this system the file cannot hold exactly — the same channel
   * `importZmx` uses, and for the same reason. Empty on almost every system.
   */
  warnings: string[];
}

export interface ZmxExportOptions {
  /**
   * Glass catalogs to name in the `GCAT` record — the libraries a reader must
   * search to resolve this file's glass names. A material carries its name but
   * not the catalog it came from, so this cannot be derived here, and guessing
   * `SCHOTT` because most files say so would be wrong for the rest. The caller
   * knows what it resolved against; `zemax-io` must not grow a glass database
   * to find out. Omitted entirely when empty.
   */
  glassCatalogs?: readonly string[];
  /**
   * A line for the file's `NOTE` record, over and above the provenance note
   * always written. Notes are annotation and change nothing about the lens.
   */
  note?: string;
}

/** The d, F and C lines, for restating a model glass as an index and an Abbe number. */
const D_LINE_NM = 587.5618;
const F_LINE_NM = 486.1327;
const C_LINE_NM = 656.2725;

/** `UNIT`'s first value. `METER` is the corpus spelling; no file writes `M`. */
const UNIT_CODES: Readonly<Record<LinearUnit, string>> = {
  mm: 'MM',
  cm: 'CM',
  m: 'METER',
  in: 'IN',
};

/**
 * The Zemax type name for each of the model's surface types. OBJECT and IMAGE
 * are not types in the file at all — they are the first and last surfaces, and
 * both are written as STANDARD, which is what the reader assumes of them.
 */
const ZMX_TYPE_NAMES: Readonly<Record<string, string>> = {
  OBJECT: 'STANDARD',
  STANDARD: 'STANDARD',
  EVEN_ASPHERE: 'EVENASPH',
  PARAXIAL: 'PARAXIAL',
  COORDINATE_TRANSFORM: 'COORDBRK',
  IMAGE: 'STANDARD',
};

/** Writes an `OpticalSystem` as .zmx text. */
export function exportZmx(system: OpticalSystem, options: ZmxExportOptions = {}): ZmxExportResult {
  const warnings: string[] = [];
  const document = systemToZmxDocument(system, options, warnings);
  return { text: formatZmxDocument(document), warnings };
}

/**
 * Maps an `OpticalSystem` onto the raw records of a .zmx document. Anything the
 * file cannot hold exactly is pushed onto `warnings`, the way the reader's own
 * stages collect theirs.
 */
export function systemToZmxDocument(
  system: OpticalSystem,
  options: ZmxExportOptions = {},
  warnings: string[] = [],
): ZmxDocument {
  return {
    header: headerRecords(system, options),
    surfaces: system.surfaces.map((surface, index) =>
      surfaceBlock(surface, index, system.surfaces.length, warnings),
    ),
    // `MNUM 1` — one configuration. The manual's minimum file ends with it, and
    // it is the only trailer record whose absence would be a claim about the
    // lens rather than about the annotation this writer has none of.
    trailer: [record('MNUM', '1')],
  };
}

/**
 * Renders records back to text, indenting surface records the way Zemax does.
 *
 * The indentation is not decoration: it is the only structural cue the format
 * gives for where the surface list ends, which is exactly how `parseZmxDocument`
 * finds the trailer. A flush-left surface record would be read back as the start
 * of the trailer, taking the rest of the surface with it.
 */
export function formatZmxDocument(document: ZmxDocument): string {
  const lines: string[] = [];
  for (const entry of document.header) {
    lines.push(line(entry));
  }
  for (const block of document.surfaces) {
    lines.push(`SURF ${block.number}`);
    for (const entry of block.records) {
      lines.push(`  ${line(entry)}`);
    }
  }
  for (const entry of document.trailer) {
    lines.push(line(entry));
  }
  return `${lines.join('\n')}\n`;
}

function line(entry: ZmxRecord): string {
  return entry.values.length > 0 ? `${entry.token} ${entry.values.join(' ')}` : entry.token;
}

/** A record with no source line — nothing written was read from a file. */
function record(token: string, ...values: (string | number)[]): ZmxRecord {
  return { token, values: values.map(String), line: 0 };
}

function headerRecords(system: OpticalSystem, options: ZmxExportOptions): ZmxRecord[] {
  // The real count, never padded up to one. A system reaches here with no fields
  // when the reader could not express the ones the file had — image-height
  // fields, which the core has no way to state — and writing a single on-axis
  // field to fill the gap would turn "Isaac does not know this system's fields"
  // into "this system is on-axis", which is a different and false claim.
  const fieldCount = system.fields.length;
  const records: ZmxRecord[] = [
    // No `VERS`. Every file in the corpus opens with one and the manual defines
    // it as "the version number of ZEMAX that created the file" — which Isaac is
    // not, and inventing a build number is exactly the plausible-looking lie
    // this project refuses elsewhere. The manual's own minimum file carries no
    // VERS either. Provenance goes in NOTE, where it is true.
    record('MODE', 'SEQ'),
    record('NAME', text(system.name)),
    record('NOTE', '0', 'Written by Isaac from its own model of this system.'),
    ...(options.note === undefined ? [] : [record('NOTE', '0', options.note)]),
    record('UNIT', UNIT_CODES[system.units], 'X', 'W', 'X', 'CM', 'MR', 'CPMM'),
    ...apertureRecords(system),
    record('ENVD', '20', '1', '0'), // 20 °C, 1 atm — the reader warns on anything else
    record('GFAC', '0', '0'), // no apodization
    ...(options.glassCatalogs && options.glassCatalogs.length > 0
      ? [record('GCAT', ...options.glassCatalogs)]
      : []),
    record('RAIM', '0', '0', '1', '1', '0', '0', '0', '0', '0', '1'), // no ray aiming
    record('SDMA', '0', '1', '0'),
    // `FTYP <field type> <telecentric> <fields> <wavelengths> …`. The two counts
    // are what trims the padded field and wavelength lists on the way back in.
    record(
      'FTYP',
      fieldType(system),
      '0',
      fieldCount,
      system.wavelengthsNm.length,
      '0',
      '0',
      '0',
      '0',
    ),
    record('ROPD', '2'),
    record('PICB', '1'),
    // The field lists, omitted entirely when there are no fields rather than
    // written empty. X fields are always zero: the core models Y fields only,
    // and the reader says so when it drops a file's X values.
    ...(fieldCount === 0
      ? []
      : [
          record('XFLN', ...new Array<string>(fieldCount).fill('0')),
          record('YFLN', ...fieldValues(system)),
          record('FWGN', ...new Array<string>(fieldCount).fill('1')),
          record('VDXN', ...new Array<string>(fieldCount).fill('0')), // no vignetting
          record('VDYN', ...new Array<string>(fieldCount).fill('0')),
          record('VCXN', ...new Array<string>(fieldCount).fill('0')),
          record('VCYN', ...new Array<string>(fieldCount).fill('0')),
          record('VANN', ...new Array<string>(fieldCount).fill('0')),
        ]),
    // `WAVM n λ weight`, and λ is in **micrometers**, not nanometers.
    ...system.wavelengthsNm.map((nm, index) => record('WAVM', index + 1, number(nm / 1000), '1')),
    record('PWAV', system.primaryWavelengthIndex + 1), // PWAV is 1-based
    record('POLS', '1', '0', '1', '0', '0', '1', '0'),
    record('GLRS', '1', '0'),
  ];
  return records;
}

/**
 * `FTYP`'s first value: 0 for a field angle, 1 for an object height. The model
 * lets a field carry either, so the file's single flag has to describe all of
 * them — a system mixing the two cannot be written, and saying so is better than
 * writing a file whose angles would be read back as millimeters.
 */
function fieldType(system: OpticalSystem): string {
  const heights = system.fields.filter((field) => field.objectHeight !== undefined);
  if (heights.length === 0) {
    return '0';
  }
  if (heights.length !== system.fields.length) {
    throw new ZmxExportError(
      'This system mixes angle fields with object-height fields. A .zmx file has one field ' +
        'type for the whole system, so it cannot express both at once.',
    );
  }
  return '1';
}

function fieldValues(system: OpticalSystem): string[] {
  return system.fields.map((field) => number(field.angleDeg ?? field.objectHeight ?? 0));
}

function apertureRecords(system: OpticalSystem): ZmxRecord[] {
  const aperture = system.aperture;
  if (aperture === undefined) {
    return [];
  }
  switch (aperture.type) {
    case 'ENTRANCE_PUPIL_DIAMETER':
      return [record('ENPD', number(aperture.value ?? 0))];
    case 'IMAGE_SPACE_FNUM':
      return [record('FNUM', number(aperture.value ?? 0), '0')];
    case 'OBJECT_SPACE_NA':
      return [record('OBNA', number(aperture.value ?? 0), '0')];
    // "The val argument is ignored" — the size comes from the stop's semi-diameter.
    case 'FLOAT_BY_STOP':
      return [record('FLOA')];
  }
}

function surfaceBlock(
  surface: Surface,
  index: number,
  count: number,
  warnings: string[],
): ZmxSurfaceBlock {
  const isObject = index === 0;
  const isImage = index === count - 1;
  const isTransform = surface.type === 'COORDINATE_TRANSFORM';
  const records: ZmxRecord[] = [];

  if (surface.comment !== undefined && surface.comment.trim() !== '') {
    records.push(record('COMM', text(surface.comment)));
  }
  if (surface.isStop) {
    records.push(record('STOP')); // a bare flag, with no value of its own
  }
  records.push(record('TYPE', ZMX_TYPE_NAMES[surface.type]!));
  // `CURV val solvetype param1 param2` per the manual, plus the two columns
  // every modern file carries. A transform has no shape, and files write zero.
  records.push(
    record('CURV', isTransform ? '0.0' : number(surface.curvature), '0', '0', '0', '0', '""'),
  );
  records.push(record('HIDE', ...new Array<string>(10).fill('0')));
  records.push(record('MIRR', '2', '0'));
  records.push(record('SLAB', index + 1));
  records.push(...parameterRecords(surface));
  records.push(
    surface.thickness === Infinity
      ? record('DISZ', 'INFINITY')
      : record('DISZ', number(surface.thickness)),
  );
  const glass = glassRecord(surface, isObject, isImage, warnings);
  if (glass) {
    records.push(glass);
  }
  if (!isTransform && surface.conic !== 0) {
    records.push(record('CONI', number(surface.conic)));
  }
  records.push(...diameterRecord(surface, isTransform));
  records.push(...surfaceApertureRecords(surface));

  return { number: index, records };
}

/**
 * The surface aperture, as the one or two records a file carries for it.
 *
 * `CLAP min max`, `OBSC min max` and `FLAP` all take the undocumented third
 * value every file in the corpus writes as `0`; the reader leaves that column
 * alone, and writing the value everything else writes is the one choice that
 * cannot surprise a reader expecting it. A `FLAP` carries the radius that
 * floated, which for us is the semi-diameter it is defined as.
 *
 * `OBDC` goes out only when the aperture is actually decentered — it is a
 * separate record, and writing `OBDC 0 0` on every apertured surface would add a
 * line to the file that says nothing.
 */
const APERTURE_TOKEN_OF: Record<ApertureKind, string> = {
  CIRCULAR: 'CLAP',
  CIRCULAR_OBSCURATION: 'OBSC',
  FLOATING: 'FLAP',
  RECTANGULAR: 'SQAP',
  RECTANGULAR_OBSCURATION: 'SQOB',
  ELLIPTICAL: 'ELAP',
  ELLIPTICAL_OBSCURATION: 'ELOB',
};

function surfaceApertureRecords(surface: Surface): ZmxRecord[] {
  const aperture = surface.aperture;
  if (aperture === undefined) {
    return [];
  }
  const token = APERTURE_TOKEN_OF[aperture.kind];
  // Every one of these records is two numbers and the undocumented third: two
  // radii for the circular kinds, two half-widths for the rest. `FLAP` writes
  // the radius that floated, which for us is the semi-diameter it is defined as.
  const floated = Number.isFinite(surface.semiDiameter) ? surface.semiDiameter : 0;
  const [first, second] = isCircularAperture(aperture.kind)
    ? [aperture.minRadius, aperture.kind === 'FLOATING' ? floated : aperture.maxRadius]
    : [aperture.halfWidthX, aperture.halfWidthY];
  const records = [record(token, number(first), number(second), '0')];
  if (aperture.decenterX !== 0 || aperture.decenterY !== 0) {
    records.push(record('OBDC', number(aperture.decenterX), number(aperture.decenterY)));
  }
  return records;
}

/**
 * `PARM n val`. Which parameter means what is a property of the surface *type* —
 * the same arrangement the editor's parameter column has, and for the same
 * reason. Outside these three types `PARM`'s columns are unverified, so nothing
 * is written rather than something invented.
 */
function parameterRecords(surface: Surface): ZmxRecord[] {
  if (surface.type === 'PARAXIAL') {
    // PARM 1 is the focal length; PARM 2 is the OPD mode, which moves no ray.
    return [record('PARM', '1', number(surface.focalLength ?? 0)), record('PARM', '2', '0')];
  }
  if (surface.type === 'EVEN_ASPHERE') {
    // PARM 1 is the coefficient on r², not r⁴ — the whole series is offset one
    // power from where it looks like it should start.
    return surface.asphericCoefficients.map((coefficient, index) =>
      record('PARM', index + 1, number(coefficient)),
    );
  }
  if (surface.type === 'COORDINATE_TRANSFORM') {
    const transform = surface.coordinateTransform;
    if (transform === undefined) {
      throw new ZmxExportError(
        `Surface ${surface.id} is a coordinate transform with no transform on it.`,
      );
    }
    return [
      record('PARM', '1', number(transform.decenterX)),
      record('PARM', '2', number(transform.decenterY)),
      record('PARM', '3', number(transform.tiltXDeg)),
      record('PARM', '4', number(transform.tiltYDeg)),
      record('PARM', '5', number(transform.tiltZDeg)),
      record('PARM', '6', transform.tiltFirst ? '1' : '0'),
    ];
  }
  return [];
}

/**
 * `GLAS name code pu nd vd pd vnd vvd vpd io ao`, where code is 0 for a fixed
 * catalog glass and 1 for a model one, and `nd`/`vd` are read only when it is a
 * model. Air is written as no record at all, which is how the reader spells it.
 */
function glassRecord(
  surface: Surface,
  isObject: boolean,
  isImage: boolean,
  warnings: string[],
): ZmxRecord | undefined {
  // `GLAS MIRROR` is not a glass: it says the surface reflects and leaves the
  // medium alone, which is why the medium after a mirror never appears in a file.
  if (surface.reflective) {
    return record('GLAS', MIRROR_GLASS_NAME, '0', '0', '0', '0', '0', '0', '0', '0', '0', '0');
  }
  // A transform names no glass — Zemax shows "-" in that column, because a
  // transform cannot be a boundary between two media. The model has already
  // forced its material to the one before it, so writing nothing loses nothing.
  if (surface.type === 'COORDINATE_TRANSFORM') {
    return undefined;
  }
  // The image surface's material is the medium after the system, which no ray
  // ever crosses; files leave it empty and the reader would read it as air.
  if (isImage) {
    return undefined;
  }
  const material = surface.material;
  if (material.name.toUpperCase() === 'AIR') {
    return undefined;
  }
  if (isModelGlass(material)) {
    const [nd, abbeNumber, deltaPgF] = modelGlassNumbers(material);
    // `pd` is the partial-dispersion column. It is written because dropping a
    // real number silently is worse than writing one this package will not read
    // back — the reader leaves that column alone on purpose, since a file in the
    // sample corpus carries a stray value there. So the asymmetry is stated
    // rather than hidden: another program gets the glass the designer specified,
    // and reloading here gets it on the normal line.
    if (deltaPgF !== 0) {
      warnings.push(
        `Surface ${surface.id} uses a model glass with a partial-dispersion deviation ` +
          `(ΔPg,F = ${deltaPgF}). It is written, but this reader ignores that column, so ` +
          'reopening the file in Isaac will put the glass back on the normal line.',
      );
    }
    return record(
      'GLAS',
      MODEL_GLASS_NAME,
      '1', // code 1 = model glass, described inline rather than named
      '0',
      number(nd),
      number(abbeNumber),
      number(deltaPgF),
      '0',
      '0',
      '0',
      '0',
      '0',
    );
  }
  // An object surface may sit in a medium, and the file states it the same way.
  void isObject;
  return record('GLAS', material.name, '0', '0', '0', '0', '0', '0', '0', '0', '0', '0');
}

/**
 * A model glass is one described by its index and Abbe number rather than named.
 * `ModelGlassMaterial` is the usual case; the other is a glass whose file gave an
 * index and no dispersion at all, which the reader turns into a `ConstantMaterial`
 * still carrying the placeholder name. Both must go back out as `___BLANK`,
 * because neither name is in any catalog.
 */
function isModelGlass(material: Material): boolean {
  return material instanceof ModelGlassMaterial || material.name.startsWith(MODEL_GLASS_NAME);
}

/**
 * The index and Abbe number to write for a model glass, taken from the material
 * itself rather than from whatever it was built with — a `ConstantMaterial`
 * standing in for a dispersionless glass has no Abbe number to remember, and
 * measuring one off the F and C lines gives the zero that says exactly that.
 */
function modelGlassNumbers(material: Material): [number, number, number] {
  if (material instanceof ModelGlassMaterial) {
    return [material.nd, material.abbeNumber, material.deltaPgF];
  }
  const nd = material.indexAt(D_LINE_NM);
  const dispersion = material.indexAt(F_LINE_NM) - material.indexAt(C_LINE_NM);
  // Vd = 0 is not an Abbe number — it is the file's way of saying there is no
  // dispersion, which is exactly the case this branch exists for.
  return [nd, dispersion === 0 ? 0 : (nd - 1) / dispersion, 0];
}

/**
 * `DIAM val solvecode pusurf`, where solvecode 0 is automatic and 1 is fixed.
 * `DIAM 0` does not mean a zero aperture — it means Zemax has no fixed one on
 * the surface, which is how an unlimited `semiDiameter` goes out and comes back.
 */
function diameterRecord(surface: Surface, isTransform: boolean): ZmxRecord[] {
  if (isTransform) {
    return [record('DIAM', '0', '0', '0', '0', '1', '""')];
  }
  return surface.semiDiameter === Infinity
    ? [record('DIAM', '0', '0', '0', '0', '1', '""')]
    : [record('DIAM', number(surface.semiDiameter), '1', '0', '0', '1', '""')];
}

/**
 * Free text as a record's values.
 *
 * A record is whitespace-delimited and one line long, so a newline in a lens name
 * or a surface comment would end the record and read the rest back as stray
 * tokens — a corrupt file from a character nobody meant to type. Runs of
 * whitespace collapse to the single spaces the reader re-joins on, so what is
 * written is exactly what comes back.
 */
function text(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A number as text, at full round-trip precision — `String` gives the shortest
 * form that reads back as the same double, so nothing is lost to formatting.
 * The exponent is upper-cased to match every file in the corpus.
 */
function number(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ZmxExportError(`Cannot write ${value} as a .zmx value.`);
  }
  return String(value).replace('e', 'E');
}
