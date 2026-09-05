/**
 * Checks an {@link OpticalSystem} against what OpticStudio says about the same
 * design in a System/Prescription Data report.
 *
 * This is the cross-check that found the EFL bug — a wrong focal length on an
 * immersed system that all 535 of Isaac's own tests agreed with, because they
 * were all written in air. A second program's arithmetic is the only thing that
 * catches a convention Isaac and its tests hold in common, so the value of this
 * file is precisely that it is *not* derived from Isaac's own understanding.
 *
 * ### Two conventions, and everything depends on them
 *
 * The report states both in prose at the head of its cardinal points block, and
 * {@link comparePrescription} reads those sentences back rather than trusting
 * this comment — if a future export words them differently, the comparison says
 * so instead of quietly checking the wrong thing.
 *
 * - **An image-space position is measured from the image surface**, not from the
 *   last vertex, **and the index of image space is divided out of it.** Isaac's
 *   `backFocalDistance` on the lithography objective is 1301.438 mm from the last
 *   vertex; OpticStudio prints 974.011, which is the same point with 1.7936 mm of
 *   water subtracted and the rest divided by 1.334321. Neither is wrong.
 * - **An object-space position is measured from surface 1**, with the index of
 *   object space divided out in the same way.
 *
 * The index is taken by **magnitude**, for the reason `signedMediaIndices`
 * exists: after an odd number of reflections the index carries a sign that
 * belongs to the direction light travels, and dividing by a signed index would
 * turn every mirror system inside out.
 *
 * ### What a disagreement means
 *
 * A masked value is a range (see `prescription.ts`), so a check can only ask
 * whether Isaac's number falls inside it. That makes a *disagreement* strong
 * evidence — the report's own printed digits exclude the answer — while an
 * *agreement* is only as strong as the digits it was checked against, which is
 * why every check carries {@link PrescriptionCheck.pinned}.
 */

import {
  SPECTRAL_LINES,
  entrancePupil,
  entrancePupilPlaneZ,
  entrancePupilRadius,
  exitPupil,
  lastRefractingSurfaceIndex,
  paraxialProperties,
  signedMediaIndices,
  type Material,
  type OpticalSystem,
} from '@isaac/optical-core';
import {
  generalValue,
  parsePrescriptionValue,
  primaryWavelengthNm,
  valueContains,
  type PrescriptionSurface,
  type PrescriptionValue,
  type ZmxPrescription,
} from './prescription.ts';

/** Whether Isaac's number fell inside what the report printed. */
export type CheckOutcome = 'agree' | 'disagree' | 'unchecked';

/** One quantity, compared. */
export interface PrescriptionCheck {
  /** Which block of the report it came from. */
  readonly section: string;
  /** What was compared, e.g. `surface 4 radius`. */
  readonly item: string;
  /** As the report printed it, `X`s included. */
  readonly expected: string;
  /** What Isaac says, or a reason when nothing could be compared. */
  readonly actual: string;
  /** The interval `expected` stands for; `NaN` when the check was not numeric. */
  readonly low: number;
  readonly high: number;
  readonly outcome: CheckOutcome;
  /**
   * Significant digits the report actually pinned. An agreement at 0 proves
   * nothing and is reported as such; a disagreement is a disagreement whatever
   * this says.
   */
  readonly pinned: number;
  /**
   * Digits the licence replaced with `X`. Few pinned digits matter only when
   * this is non-zero — a conic printed `0` pinned none because it needed none.
   */
  readonly masked: number;
  readonly note?: string;
}

export interface PrescriptionComparison {
  readonly checks: readonly PrescriptionCheck[];
  readonly agreed: number;
  readonly disagreed: number;
  readonly unchecked: number;
  /** Problems with the comparison itself, not with the design. */
  readonly warnings: readonly string[];
}

export interface CompareOptions {
  /**
   * Wavelength to compare at, in nanometers. Defaults to the report's own
   * primary wavelength, falling back to the system's.
   */
  readonly wavelengthNm?: number;
  /**
   * Extra relative slack on a derived quantity, for the float error of dividing
   * by an index or subtracting two large positions. Not a fudge for a real
   * disagreement: at 1e-9 it is far below the digit the report withheld.
   */
  readonly relativeSlack?: number;
}

const DEFAULT_SLACK = 1e-9;

/** The sentences a report states its reference frame in, as this file assumes them. */
const EXPECTED_CONVENTIONS = [
  /object space positions are measured with respect to surface 1/i,
  /image space positions are measured with respect to the image surface/i,
  /the index in both the object space and image space is considered/i,
];

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-4 && magnitude < 1e9) return value.toFixed(6).replace(/\.?0+$/, '');
  return value.toExponential(8);
}

class Checks {
  private readonly list: PrescriptionCheck[] = [];
  private readonly slack: number;

  // A field and an assignment, not a constructor parameter property: those need
  // code generated and the engine packages are run by type stripping alone.
  public constructor(slack: number) {
    this.slack = slack;
  }

  /** Compares a number against a printed value. */
  public value(
    section: string,
    item: string,
    expected: PrescriptionValue | undefined,
    actual: number | undefined,
    note?: string,
  ): void {
    if (expected === undefined) {
      this.skip(section, item, '-', 'the report does not state it', note);
      return;
    }
    if (actual === undefined || Number.isNaN(actual)) {
      this.skip(section, item, expected.text, 'Isaac does not report it', note);
      return;
    }
    const slack = Number.isFinite(actual) ? Math.abs(actual) * this.slack : 0;
    const inside =
      valueContains(expected, actual) ||
      (Number.isFinite(actual) &&
        actual >= expected.low - slack &&
        actual <= expected.high + slack);
    this.list.push({
      section,
      item,
      expected: expected.text,
      actual: formatNumber(actual),
      low: expected.low,
      high: expected.high,
      outcome: inside ? 'agree' : 'disagree',
      pinned: expected.significantDigits,
      masked: expected.maskedDigits,
      note,
    });
  }

  /** Compares two strings that must match exactly once normalized. */
  public text(
    section: string,
    item: string,
    expected: string,
    actual: string,
    note?: string,
  ): void {
    const normalize = (text: string) => text.toUpperCase().replace(/[\s_-]/g, '');
    this.list.push({
      section,
      item,
      expected,
      actual,
      low: Number.NaN,
      high: Number.NaN,
      outcome: normalize(expected) === normalize(actual) ? 'agree' : 'disagree',
      pinned: Infinity,
      masked: 0,
      note,
    });
  }

  public skip(
    section: string,
    item: string,
    expected: string,
    reason: string,
    note?: string,
  ): void {
    this.list.push({
      section,
      item,
      expected,
      actual: reason,
      low: Number.NaN,
      high: Number.NaN,
      outcome: 'unchecked',
      pinned: 0,
      masked: 0,
      note,
    });
  }

  public done(warnings: string[]): PrescriptionComparison {
    return {
      checks: this.list,
      agreed: this.list.filter((check) => check.outcome === 'agree').length,
      disagreed: this.list.filter((check) => check.outcome === 'disagree').length,
      unchecked: this.list.filter((check) => check.outcome === 'unchecked').length,
      warnings,
    };
  }
}

/** The Abbe number of any material, from the three lines it is defined by. */
function abbeNumberOf(material: Material): number {
  const d = material.indexAt(SPECTRAL_LINES.d);
  const spread = material.indexAt(SPECTRAL_LINES.F) - material.indexAt(SPECTRAL_LINES.C);
  return spread === 0 ? Infinity : (d - 1) / spread;
}

/** An exact integer the report stated, as a value with no room in it. */
function exactly(count: number): PrescriptionValue {
  return {
    text: String(count),
    low: count,
    high: count,
    maskedDigits: 0,
    significantDigits: Infinity,
  };
}

function compareSurfaces(
  checks: Checks,
  system: OpticalSystem,
  prescription: ZmxPrescription,
  wavelengthNm: number,
  warnings: string[],
): void {
  const section = 'Surface data';
  checks.value(
    'Structure',
    'surface count',
    exactly(prescription.surfaces.length),
    system.surfaces.length,
  );
  if (prescription.surfaces.length !== system.surfaces.length) {
    warnings.push(
      `The report has ${prescription.surfaces.length} surfaces and Isaac has ` +
        `${system.surfaces.length}; rows are compared by position, so everything ` +
        'past the first difference says nothing.',
    );
  }

  const reportedStop = prescription.surfaces.findIndex((row) => row.isStop);
  if (reportedStop !== -1) {
    checks.value('Structure', 'stop surface', exactly(reportedStop), system.stopIndex);
  }

  const count = Math.min(prescription.surfaces.length, system.surfaces.length);
  for (let index = 0; index < count; index += 1) {
    const row = prescription.surfaces[index]!;
    const surface = system.surfaceAt(index);
    const name = `surface ${row.label}`;

    checks.value(section, `${name} radius`, row.radius, surface.radius);
    // The image surface has nothing after it, so the report prints no thickness.
    if (index < prescription.surfaces.length - 1) {
      checks.value(section, `${name} thickness`, row.thickness, surface.thickness);
    }
    checks.value(section, `${name} conic`, row.conic, surface.conic ?? 0);

    if (Number.isFinite(surface.semiDiameter) && row.clearDiameter !== undefined) {
      // OpticStudio's column is a diameter; Isaac stores a semi-diameter.
      const factor = row.clearDiameterIsSemi ? 1 : 2;
      checks.value(
        section,
        `${name} semi-diameter`,
        {
          ...row.clearDiameter,
          low: row.clearDiameter.low / factor,
          high: row.clearDiameter.high / factor,
          text: factor === 2 ? `${row.clearDiameter.text} / 2` : row.clearDiameter.text,
        },
        surface.semiDiameter,
      );
    } else {
      checks.skip(
        section,
        `${name} semi-diameter`,
        row.clearDiameter?.text ?? '-',
        'the file states none, so this is OpticStudio\u2019s own computed envelope',
      );
    }

    compareGlass(checks, section, name, row, surface.material, prescription, wavelengthNm);
  }
}

/**
 * Reads the Glass column, which states either a name or — for a model glass,
 * which is all the file itself gave — the pair `nd, Vd`.
 */
function compareGlass(
  checks: Checks,
  section: string,
  name: string,
  row: PrescriptionSurface,
  material: Material,
  prescription: ZmxPrescription,
  wavelengthNm: number,
): void {
  const cell = row.glass.trim();
  const isAir = Math.abs(material.indexAt(wavelengthNm) - 1) < 1e-9;

  if (cell === '') {
    checks.text(section, `${name} glass`, 'air', isAir ? 'air' : material.name);
    return;
  }

  const halves = cell.split(',');
  const nd =
    halves.length === 2 ? parsePrescriptionValue(halves[0]!, prescription.precision) : undefined;
  const vd =
    halves.length === 2 ? parsePrescriptionValue(halves[1]!, prescription.precision) : undefined;
  if (nd !== undefined && vd !== undefined) {
    checks.value(section, `${name} glass nd`, nd, material.indexAt(SPECTRAL_LINES.d));
    const abbe = abbeNumberOf(material);
    if (vd.low <= 0 && vd.high >= 0 && !Number.isFinite(abbe)) {
      // The file gave an index and no dispersion. The report writes that Vd as
      // zero — an Abbe number of zero would mean infinite dispersion — and Isaac
      // writes it as a material with no dispersion at all. Same statement.
      checks.text(section, `${name} glass Vd`, '0 (no dispersion)', '0 (no dispersion)');
    } else {
      checks.value(section, `${name} glass Vd`, vd, abbe);
    }
    return;
  }

  checks.text(section, `${name} glass`, cell, material.name);
}

function compareAspheres(
  checks: Checks,
  system: OpticalSystem,
  prescription: ZmxPrescription,
): void {
  const section = 'Aspheric coefficients';
  const count = Math.min(prescription.surfaces.length, system.surfaces.length);
  for (let index = 0; index < count; index += 1) {
    const row = prescription.surfaces[index]!;
    if (row.asphericCoefficients.length === 0) continue;
    const actual = system.surfaceAt(index).asphericCoefficients ?? [];
    row.asphericCoefficients.forEach((expected, slot) => {
      const power = (slot + 1) * 2;
      checks.value(section, `surface ${row.label} r^${power}`, expected, actual[slot] ?? 0);
    });
  }
}

function compareCardinalPoints(
  checks: Checks,
  system: OpticalSystem,
  prescription: ZmxPrescription,
  wavelengthNm: number,
  warnings: string[],
): void {
  const section = 'Cardinal points';
  const block =
    prescription.cardinalPoints.find((candidate) => candidate.isPrimary) ??
    prescription.cardinalPoints[0];
  if (block === undefined) {
    checks.skip(section, 'all', '-', 'the report has no CARDINAL POINTS block');
    return;
  }

  for (const expected of EXPECTED_CONVENTIONS) {
    if (!prescription.conventions.some((sentence) => expected.test(sentence))) {
      warnings.push(
        `The report does not state the convention this comparison assumes (${expected.source}); ` +
          'cardinal points are compared on an assumption the report did not confirm.',
      );
    }
  }

  const paraxial = paraxialProperties(system, wavelengthNm);
  const media = signedMediaIndices(system, wavelengthNm);
  const objectIndex = Math.abs(media[0]!);
  const imageIndex = Math.abs(media[lastRefractingSurfaceIndex(system)]!);
  const firstVertexZ = system.axialPositionAt(1);
  const imageSurfaceZ = paraxial.imageSurfaceZ;

  /** An image-space position as the report measures it. */
  const inImageSpace = (z: number): number => (z - imageSurfaceZ) / imageIndex;
  /** An object-space position as the report measures it. */
  const inObjectSpace = (z: number): number => (z - firstVertexZ) / objectIndex;

  const efl = paraxial.effectiveFocalLength;
  const focalLength = block.rows.get('Focal Length');
  checks.value(section, 'focal length (object space)', focalLength?.objectSpace, -efl);
  checks.value(section, 'focal length (image space)', focalLength?.imageSpace, efl);

  const focalPlanes = block.rows.get('Focal Planes');
  checks.value(
    section,
    'front focal plane',
    focalPlanes?.objectSpace,
    paraxial.frontFocalDistance / objectIndex,
    'first vertex → front focus, index divided out',
  );
  checks.value(
    section,
    'rear focal plane',
    focalPlanes?.imageSpace,
    inImageSpace(system.vertexZAt(lastRefractingSurfaceIndex(system)) + paraxial.backFocalDistance),
    'image surface → rear focus, index divided out',
  );

  const principal = block.rows.get('Principal Planes');
  checks.value(
    section,
    'front principal plane',
    principal?.objectSpace,
    inObjectSpace(paraxial.frontPrincipalPlaneZ),
  );
  checks.value(
    section,
    'rear principal plane',
    principal?.imageSpace,
    inImageSpace(paraxial.rearPrincipalPlaneZ),
  );

  for (const row of ['Anti-Principal Planes', 'Nodal Planes', 'Anti-Nodal Planes']) {
    const value = block.rows.get(row);
    if (value === undefined) continue;
    checks.skip(
      section,
      row.toLowerCase(),
      value.imageSpace?.text ?? '-',
      'Isaac does not report it',
    );
  }
}

function compareGeneralData(
  checks: Checks,
  system: OpticalSystem,
  prescription: ZmxPrescription,
  wavelengthNm: number,
): void {
  const section = 'General lens data';
  const paraxial = paraxialProperties(system, wavelengthNm);
  const last = lastRefractingSurfaceIndex(system);
  const imageIndex = Math.abs(signedMediaIndices(system, wavelengthNm)[last]!);
  const objectIndex = Math.abs(signedMediaIndices(system, wavelengthNm)[0]!);

  /** An image-space position as the report measures it: from the image surface, index out. */
  const inImageSpace = (z: number): number => (z - paraxial.imageSurfaceZ) / imageIndex;

  checks.value(
    section,
    'effective focal length',
    generalValue(prescription, 'Effective Focal Length', 'in air'),
    paraxial.effectiveFocalLength,
  );
  checks.value(
    section,
    'back focal length',
    generalValue(prescription, 'Back Focal Length'),
    inImageSpace(system.vertexZAt(last) + paraxial.backFocalDistance),
    'image surface \u2192 rear focus, index divided out \u2014 not Isaac\u2019s BFD',
  );
  checks.value(
    section,
    'total track',
    generalValue(prescription, 'Total Track'),
    system.axialPositionAt(system.surfaces.length - 1) - system.axialPositionAt(1),
  );
  checks.value(
    section,
    'paraxial magnification',
    generalValue(prescription, 'Paraxial Magnification'),
    paraxial.magnification,
  );

  const maxField = system.fields.reduce(
    (widest, field) => Math.max(widest, Math.abs(field.objectHeight ?? field.angleDeg ?? 0)),
    0,
  );
  checks.value(
    section,
    'maximum radial field',
    generalValue(prescription, 'Maximum Radial Field'),
    maxField,
  );
  checks.value(
    section,
    'paraxial image height',
    generalValue(prescription, 'Paraxial Image Height'),
    Math.abs(paraxial.magnification) * maxField,
  );

  comparePupils(checks, section, system, prescription, wavelengthNm, paraxial, inImageSpace);

  checks.value(
    section,
    'primary wavelength',
    generalValue(prescription, 'Primary Wavelength [\u00b5m]'),
    system.primaryWavelengthNm / 1000,
  );
  void objectIndex;
}

/**
 * The pupil block, where OpticStudio and Isaac name two different things the
 * same way and one convention reaches further than it looks.
 *
 * **A stop is not always what limits the beam.** This system declares its
 * aperture as an entrance pupil diameter of 1000, while its stop surface is
 * drawn 29.93 mm across — so the beam fills only part of it. OpticStudio's
 * *Stop Radius* is the beam at the stop; Isaac's `stopRadius` is the stop's own
 * clear radius, which is the honest answer to a different question and the one
 * `Surface.blocksAt` needs. The two coincide only on a system that floats its
 * aperture by the stop, which is why this went unnoticed. The beam radius is
 * derived here rather than in the engine, from two things Isaac does report:
 * the pupil the system declares, and the magnification from stop to pupil.
 *
 * The same distinction sizes the exit pupil, and the *position* of the exit
 * pupil turns out to be an image-space quantity like any other — measured from
 * the image surface with the index divided out, exactly as the cardinal points
 * block says, though the general block never states it.
 */
function comparePupils(
  checks: Checks,
  section: string,
  system: OpticalSystem,
  prescription: ZmxPrescription,
  wavelengthNm: number,
  paraxial: ReturnType<typeof paraxialProperties>,
  inImageSpace: (z: number) => number,
): void {
  let beamAtStop: number | undefined;
  let declaredRadius: number | undefined;
  try {
    // Takes the system's primary wavelength; the pupil is a first-order
    // quantity and the report states it once, not per wavelength.
    declaredRadius = entrancePupilRadius(system);
    beamAtStop = declaredRadius / Math.abs(entrancePupil(system, wavelengthNm).magnification);
  } catch {
    // A system with no aperture, or a stop with no size, has no beam to measure.
  }

  checks.value(
    section,
    'entrance pupil diameter',
    generalValue(prescription, 'Entrance Pupil Diameter'),
    declaredRadius === undefined ? undefined : declaredRadius * 2,
  );
  checks.value(
    section,
    'stop radius',
    generalValue(prescription, 'Stop Radius'),
    beamAtStop,
    'the beam at the stop, not the stop\u2019s own clear radius',
  );

  try {
    const z = entrancePupilPlaneZ(system, wavelengthNm) - system.axialPositionAt(1);
    checks.value(
      section,
      'entrance pupil position',
      generalValue(prescription, 'Entrance Pupil Position'),
      z,
    );
  } catch (error) {
    checks.skip(
      section,
      'entrance pupil position',
      generalValue(prescription, 'Entrance Pupil Position')?.text ?? '-',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const pupil = exitPupil(system, wavelengthNm);
    checks.value(
      section,
      'exit pupil position',
      generalValue(prescription, 'Exit Pupil Position'),
      inImageSpace(pupil.z),
      'image surface \u2192 exit pupil, index divided out',
    );
    checks.value(
      section,
      'exit pupil diameter',
      generalValue(prescription, 'Exit Pupil Diameter'),
      beamAtStop === undefined ? undefined : beamAtStop * Math.abs(pupil.magnification) * 2,
      'the beam at the exit pupil, not the image of the whole stop',
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    checks.skip(
      section,
      'exit pupil position',
      generalValue(prescription, 'Exit Pupil Position')?.text ?? '-',
      reason,
    );
    checks.skip(
      section,
      'exit pupil diameter',
      generalValue(prescription, 'Exit Pupil Diameter')?.text ?? '-',
      reason,
    );
  }

  const efl = paraxial.effectiveFocalLength;
  checks.value(
    section,
    'image space F/#',
    generalValue(prescription, 'Image Space F/#'),
    declaredRadius === undefined ? undefined : efl / (declaredRadius * 2),
  );
}

/** Fields and wavelengths, which catch a unit read wrongly on the way in. */
function compareSources(
  checks: Checks,
  system: OpticalSystem,
  prescription: ZmxPrescription,
): void {
  const section = 'Fields and wavelengths';
  // A report that lists none stated none; comparing against zero would turn a
  // partial export into a disagreement about the lens.
  if (prescription.fields.length === 0) {
    checks.skip(section, 'fields', '-', 'the report lists none');
  } else {
    checks.value(section, 'field count', exactly(prescription.fields.length), system.fields.length);
  }
  prescription.fields.forEach((field, index) => {
    const own = system.fields[index];
    if (own === undefined) return;
    const value = own.objectHeight ?? own.angleDeg ?? 0;
    checks.value(section, `field ${index + 1} y`, exactly(field.y), value);
  });

  if (prescription.wavelengths.length === 0) {
    checks.skip(section, 'wavelengths', '-', 'the report lists none');
  } else {
    checks.value(
      section,
      'wavelength count',
      exactly(prescription.wavelengths.length),
      system.wavelengthsNm.length,
    );
  }
  prescription.wavelengths.forEach((wavelength, index) => {
    const own = system.wavelengthsNm[index];
    if (own === undefined) return;
    // The report is in micrometres and the model in nanometres.
    checks.value(section, `wavelength ${index + 1}`, exactly(wavelength.um), own / 1000);
  });
}

/**
 * Compares a system against a report of the same design.
 *
 * Nothing here mutates either side, and a quantity Isaac cannot produce is
 * reported as unchecked rather than skipped silently — a comparison with a line
 * missing cannot be read against the report it came from.
 */
export function comparePrescription(
  system: OpticalSystem,
  prescription: ZmxPrescription,
  options: CompareOptions = {},
): PrescriptionComparison {
  const warnings: string[] = [...prescription.warnings];
  const wavelengthNm =
    options.wavelengthNm ?? primaryWavelengthNm(prescription) ?? system.primaryWavelengthNm;
  const checks = new Checks(options.relativeSlack ?? DEFAULT_SLACK);

  compareSurfaces(checks, system, prescription, wavelengthNm, warnings);
  compareAspheres(checks, system, prescription);
  compareSources(checks, system, prescription);
  compareGeneralData(checks, system, prescription, wavelengthNm);
  compareCardinalPoints(checks, system, prescription, wavelengthNm, warnings);

  return checks.done(warnings);
}
