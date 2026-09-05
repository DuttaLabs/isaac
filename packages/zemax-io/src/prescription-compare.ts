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
  fieldValue,
  systemFieldKind,
  surfacePower,
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

  /**
   * Agrees when the report's value matches **any** of several candidates, and
   * says which. For a quantity whose definition the available exports do not
   * pin down — OpticStudio's Back Focal Length is measured from the image
   * surface on one design and from the last vertex on another — this keeps a
   * real check (a value wrong by any other factor matches none of them) without
   * raising an alarm about a definition rather than about the lens.
   */
  public oneOf(
    section: string,
    item: string,
    expected: PrescriptionValue | undefined,
    candidates: readonly (readonly [string, number | undefined])[],
  ): void {
    if (expected === undefined) {
      this.skip(section, item, '-', 'the report does not state it');
      return;
    }
    const matched = candidates.find(
      ([, value]) => value !== undefined && !Number.isNaN(value) && valueContains(expected, value),
    );
    if (matched !== undefined) {
      this.list.push({
        section,
        item,
        expected: expected.text,
        actual: formatNumber(matched[1]!),
        low: expected.low,
        high: expected.high,
        outcome: 'agree',
        pinned: expected.significantDigits,
        masked: expected.maskedDigits,
        note: `measured ${matched[0]}`,
      });
      return;
    }
    const first = candidates[0];
    this.value(
      section,
      item,
      expected,
      first?.[1],
      `none of: ${candidates.map(([label, value]) => `${label} ${formatNumber(value ?? Number.NaN)}`).join('; ')}`,
    );
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

/**
 * Which units a report's image-space column is written in.
 *
 * **The same optic can be reported two ways, and the corpus has both.**
 * `7301707.zmx` and `7301707-spherical.zmx` are the same lithography objective
 * with the same back focal distance to the last digit, both imaging into water —
 * and OpticStudio states the first *referred to air* (focal length `1/φ`,
 * distances divided by the water) and the second *in the water's own units*
 * (focal length `n′/φ`, distances left alone). Both reports carry the identical
 * sentence about the index being considered, so the prose does not say which.
 * The one structural difference is the glass on the IMA row: blank in the first,
 * `WATER` in the second.
 *
 * Rather than infer the cause, the frame is **read off the report**: its own
 * image-space focal length is either the EFL or the EFL times the image index,
 * and which one it is says how every image-space distance in that report is
 * scaled. That keeps the focal-length check at full strength — the reported
 * value still has to equal one of the two, and a focal length wrong by any other
 * factor matches neither and is caught.
 */
interface ImageFrame {
  /** `1` when the column is referred to air, `n′` when it is in the medium. */
  readonly scale: number;
  /** Divide a geometric image-space distance by this to get the report's units. */
  readonly divisor: number;
  /** False when the report's focal length matched neither candidate. */
  readonly recognized: boolean;
}

function imageFrameOf(prescription: ZmxPrescription, efl: number, imageIndex: number): ImageFrame {
  const block =
    prescription.cardinalPoints.find((candidate) => candidate.isPrimary) ??
    prescription.cardinalPoints[0];
  const stated =
    block?.rows.get('Focal Length')?.imageSpace ??
    generalValue(prescription, 'Effective Focal Length', 'in image space');

  if (stated !== undefined && Number.isFinite(efl)) {
    if (valueContains(stated, efl)) return { scale: 1, divisor: imageIndex, recognized: true };
    if (valueContains(stated, efl * imageIndex)) {
      return { scale: imageIndex, divisor: 1, recognized: true };
    }
    return { scale: 1, divisor: imageIndex, recognized: false };
  }
  // Nothing to calibrate against; air-referred is what most reports use.
  return { scale: 1, divisor: imageIndex, recognized: true };
}

/**
 * `-1` after an odd number of reflections, `+1` otherwise — the sign image space
 * carries because it genuinely runs backwards, read off the last medium's index.
 * Object-space quantities have to take it back out; they never reflected.
 */
function travelSign(system: OpticalSystem, wavelengthNm: number): number {
  const media = signedMediaIndices(system, wavelengthNm);
  return Math.sign(media[lastRefractingSurfaceIndex(system)]!) || 1;
}

/** The Abbe number of any material, from the three lines it is defined by. */
function abbeNumberOf(material: Material): number {
  const d = material.indexAt(SPECTRAL_LINES.d);
  const spread = material.indexAt(SPECTRAL_LINES.F) - material.indexAt(SPECTRAL_LINES.C);
  return spread === 0 ? Infinity : (d - 1) / spread;
}

/** The last surface that actually bends light, which is not always the last one. */
function lastPoweredSurfaceIndex(system: OpticalSystem, wavelengthNm: number): number | undefined {
  const media = signedMediaIndices(system, wavelengthNm);
  for (let index = lastRefractingSurfaceIndex(system); index >= 1; index -= 1) {
    if (surfacePower(system.surfaceAt(index), media[index - 1]!, media[index]!) !== 0) return index;
  }
  return undefined;
}

/** Isaac's surface types under the names OpticStudio prints in the Type column. */
const ZMX_SURFACE_TYPES: Readonly<Record<string, string>> = {
  OBJECT: 'STANDARD',
  IMAGE: 'STANDARD',
  STANDARD: 'STANDARD',
  EVEN_ASPHERE: 'EVENASPH',
  PARAXIAL: 'PARAXIAL',
  TILTED: 'TILTSURF',
  COORDINATE_TRANSFORM: 'COORDBRK',
};

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

  // **A curved image surface is counted by one program and not the other.** Light
  // stops at the image plane, so Isaac's paraxial trace skips it and its
  // curvature describes a curved detector — a retina — and nothing else.
  // OpticStudio evidently carries it into the first-order calculation: on
  // `Liang2002a.zmx`, a schematic eye whose retina has R = -1.994, refracting
  // there turns Isaac's EFL of 79.05 into -27.87 against a reported -27.88, and
  // the residual is the model-glass formula this project deliberately does not
  // reproduce. Isaac's reading is the defensible one; the numbers are simply not
  // comparable, and that is worth saying rather than reporting six mysteries.
  if (Number.isFinite(system.imageSurface.radius)) {
    warnings.push(
      'The image surface is curved. OpticStudio appears to include it in the paraxial ' +
        'calculation and Isaac does not \u2014 light stops there \u2014 so the first-order ' +
        'figures below are not comparable on this design.',
    );
  }

  const count = Math.min(prescription.surfaces.length, system.surfaces.length);
  for (let index = 0; index < count; index += 1) {
    const row = prescription.surfaces[index]!;
    const surface = system.surfaceAt(index);
    const name = `surface ${row.label}`;

    checks.text(section, `${name} type`, row.type, ZMX_SURFACE_TYPES[surface.type] ?? surface.type);
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

    compareGlass(checks, section, name, row, surface, prescription, wavelengthNm);
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
  surface: { material: Material; reflective: boolean },
  prescription: ZmxPrescription,
  wavelengthNm: number,
): void {
  const cell = row.glass.trim();
  const material = surface.material;

  // `MIRROR` is not a medium. OpticStudio writes it where the glass goes, as the
  // file does, and Isaac carries it as a flag with the medium left alone — so
  // reading the column as a material name would compare it against whatever the
  // mirror happens to sit in.
  if (cell.toUpperCase() === 'MIRROR') {
    checks.text(
      section,
      `${name} glass`,
      'MIRROR',
      surface.reflective ? 'MIRROR' : `not reflective (${material.name})`,
    );
    return;
  }

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
  const travel = travelSign(system, wavelengthNm);
  const firstVertexZ = system.axialPositionAt(1);

  // **The two columns are not measured the same way**, which two exports agree
  // on and only an immersed *object* space could show. Image space is referred
  // to air: positions divided by n′ and the focal length coming out as the EFL.
  // Object space is geometric: positions left in the medium's own units and the
  // focal length carrying its index. On every lens in the corpus but two the
  // object sits in air, where the difference is a factor of one.
  const efl = paraxial.effectiveFocalLength;
  const frame = imageFrameOf(prescription, efl, imageIndex);
  const inImageSpace = (z: number): number => (z - paraxial.imageSurfaceZ) / frame.divisor;
  const inObjectSpace = (z: number): number => z - firstVertexZ;
  if (!frame.recognized) {
    warnings.push(
      'The report\u2019s image-space focal length is neither Isaac\u2019s EFL nor the EFL times ' +
        'the image index, so which units its image-space column is in could not be read off it. ' +
        'Everything image-space below is compared as though referred to air.',
    );
  }

  // **After an odd number of reflections the object-space column is in a frame
  // this comparison cannot pin.** On the 5-mirror Offner compensator OpticStudio
  // puts the front focal plane at +6.662 where Isaac has -6.662833 — the same
  // magnitude, mirrored — and the front principal plane at 9.310 where Isaac has
  // -4.015465, which is not the mirror of anything. Isaac's is the one that
  // satisfies the definition: place the object there and the magnification is
  // exactly +1, while at OpticStudio's it is 0.166. So the object-space rows
  // below are reported for information on such a system, not as a verdict.
  if (travel < 0) {
    warnings.push(
      'The system has an odd number of reflections, and OpticStudio\u2019s object-space column ' +
        'is then in a frame this comparison could not pin. Isaac\u2019s front principal plane is ' +
        'verified against the definition instead \u2014 the magnification there is +1.',
    );
  }

  const focalLength = block.rows.get('Focal Length');
  checks.value(
    section,
    'focal length (object space)',
    focalLength?.objectSpace,
    -efl * objectIndex * travel,
    'n\u2080/\u03c6, with the sign image space\u2019s reversal gives it taken back out',
  );
  checks.value(
    section,
    'focal length (image space)',
    focalLength?.imageSpace,
    efl * frame.scale,
    frame.scale === 1
      ? 'this report states image space referred to air'
      : 'this report states image space in the medium\u2019s own units',
  );

  const focalPlanes = block.rows.get('Focal Planes');
  checks.value(
    section,
    'front focal plane',
    focalPlanes?.objectSpace,
    paraxial.frontFocalDistance,
    'first vertex \u2192 front focus, in object space\u2019s own units',
  );
  checks.value(
    section,
    'rear focal plane',
    focalPlanes?.imageSpace,
    inImageSpace(
      system.axialPositionAt(lastRefractingSurfaceIndex(system)) + paraxial.backFocalDistance,
    ),
    'image surface \u2192 rear focus, index divided out',
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
  const frame = imageFrameOf(prescription, paraxial.effectiveFocalLength, imageIndex);

  /** An image-space position as *this* report measures it — see {@link imageFrameOf}. */
  const inImageSpace = (z: number): number => (z - paraxial.imageSurfaceZ) / frame.divisor;

  // **The general block and the cardinal block disagree about the EFL's sign**,
  // and both are self-consistent. The cardinal block's image-space focal length
  // carries the reversal an odd number of reflections gives image space, and
  // Isaac's EFL matches it; the general block states the same length referred to
  // object space, which never reflected, so the sign comes back out. Fits all
  // three known exports: 7301707 (no mirrors, +3895.847), Dyson1959 (one mirror,
  // +340.548 here against -340.548 there), and the Unobscured Gregorian (two
  // mirrors, -1237.63 in both). Read a disagreement here as a convention to
  // check rather than as a wrong focal length — the cardinal block is where the
  // signed value is tested.
  checks.value(
    section,
    'effective focal length',
    generalValue(prescription, 'Effective Focal Length', 'in air'),
    paraxial.effectiveFocalLength * travelSign(system, wavelengthNm),
    'referred to object space, so an odd number of mirrors does not turn it over',
  );
  // OpticStudio's Back Focal Length is *not* Isaac's BFD, and the six exports
  // available do not agree on where it is measured from: on 7301707 it is the
  // image surface (and equals that report's own cardinal rear focal plane), on
  // sc_endo1 it is the last vertex. Both are checked, and which one matched is
  // recorded — the cardinal block is where the quantity is pinned properly.
  // **`axialPositionAt`, never `vertexZAt`.** They are two different coordinates
  // and the difference is invisible until a system is folded: the first is how far
  // along the axis a surface is, unfolded, and the second is where it really sits
  // once tilts have bent the axis. First-order optics describes one straight axis,
  // so every distance here is the unfolded one — which is what `paraxialProperties`
  // itself uses. On `Yolo.zmx` the two differ by 25.352 mm at the last surface, and
  // that was the whole of a rear focal plane reported as -25.684 against -0.332.
  const rearFocusZ = system.axialPositionAt(last) + paraxial.backFocalDistance;
  const lastPowered = lastPoweredSurfaceIndex(system, wavelengthNm);
  checks.oneOf(section, 'back focal length', generalValue(prescription, 'Back Focal Length'), [
    ['from the image surface', inImageSpace(rearFocusZ)],
    ['from the last vertex', paraxial.backFocalDistance / frame.divisor],
    [
      'from the last powered surface',
      lastPowered === undefined
        ? undefined
        : (rearFocusZ - system.axialPositionAt(lastPowered)) / frame.divisor,
    ],
  ]);
  // Total track is the axial *extent*, not the distance from the first surface
  // to the last: a mirror sends the later surfaces back the way they came, so
  // the last one is behind the first and the difference is negative.
  const axial = system.surfaces
    .map((_, index) => system.axialPositionAt(index))
    .slice(1)
    .filter((position) => Number.isFinite(position));
  checks.value(
    section,
    'total track',
    generalValue(prescription, 'Total Track'),
    axial.length === 0 ? undefined : Math.max(...axial) - Math.min(...axial),
  );
  checks.value(
    section,
    'paraxial magnification',
    generalValue(prescription, 'Paraxial Magnification'),
    paraxial.magnification,
  );

  // Everything below this line is a fact about the fields, so on a system whose
  // fields Isaac could not read they are all one fact, said once above.
  if (system.fields.length === 0) {
    for (const item of ['maximum radial field', 'paraxial image height']) {
      checks.skip(section, item, '-', 'Isaac could not read this file\u2019s fields');
    }
    comparePupils(checks, section, system, prescription, wavelengthNm, paraxial, inImageSpace);
    checks.value(
      section,
      'primary wavelength',
      generalValue(prescription, 'Primary Wavelength [\u00b5m]'),
      system.primaryWavelengthNm / 1000,
    );
    return;
  }

  const maxField = system.fields.reduce(
    (widest, field) => Math.max(widest, Math.abs(fieldValue(field))),
    0,
  );
  checks.value(
    section,
    'maximum radial field',
    generalValue(prescription, 'Maximum Radial Field'),
    maxField,
  );
  // At a finite conjugate the image height is the object height magnified. At an
  // infinite one there is no magnification and the field is an *angle*, so the
  // height is the object-space focal length times its tangent — and that focal
  // length carries the object index, which is what makes an endoscope looking
  // into water come out right.
  const objectIndex = Math.abs(signedMediaIndices(system, wavelengthNm)[0]!);
  const infiniteConjugate = !Number.isFinite(system.objectSurface.thickness);
  // Three field kinds, three ways to the same number. Stated as an image height
  // it *is* the answer; as an object height it is that magnified; as an angle at
  // an infinite conjugate it is the object-space focal length times the tangent,
  // and that focal length carries the object index — which is what an endoscope
  // looking into water needs.
  const kind = systemFieldKind(system);
  const imageHeight =
    kind === 'IMAGE_HEIGHT'
      ? maxField
      : infiniteConjugate
        ? Math.abs(paraxial.effectiveFocalLength) *
          objectIndex *
          Math.tan((maxField * Math.PI) / 180)
        : Math.abs(paraxial.magnification) * maxField;
  checks.value(
    section,
    'paraxial image height',
    generalValue(prescription, 'Paraxial Image Height'),
    imageHeight,
    kind === 'IMAGE_HEIGHT'
      ? 'the fields are stated as image heights, so this is one of them'
      : infiniteConjugate
        ? 'object at infinity: |n\u2080\u00b7EFL|\u00b7tan\u03b8'
        : undefined,
  );

  comparePupils(checks, section, system, prescription, wavelengthNm, paraxial, inImageSpace);

  checks.value(
    section,
    'primary wavelength',
    generalValue(prescription, 'Primary Wavelength [\u00b5m]'),
    system.primaryWavelengthNm / 1000,
  );
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
      'image surface \u2192 exit pupil, index divided out. Isaac\u2019s pupils are paraxial and, ' +
        'on a folded system, describe the unfolded equivalent \u2014 so expect a difference ' +
        'against a report that traced rays through the tilts',
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
    declaredRadius === undefined ? undefined : Math.abs(efl) / (declaredRadius * 2),
    'stated as a magnitude; the focal length\u2019s sign is checked on its own',
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
  } else if (system.fields.length === 0) {
    // One clear statement rather than a disagreement per field-dependent figure.
    // The usual cause is a field type the reader refuses — image height, say —
    // and the import warns about it by name.
    checks.text(
      section,
      'field count',
      String(prescription.fields.length),
      'none: Isaac could not read this file\u2019s fields',
    );
  } else {
    checks.value(section, 'field count', exactly(prescription.fields.length), system.fields.length);
  }

  prescription.fields.forEach((field, index) => {
    const own = system.fields[index];
    if (own === undefined) return;
    checks.value(section, `field ${index + 1} y`, exactly(field.y), fieldValue(own));
  });

  // **Isaac has no X field, and silence about that would be the wrong answer.**
  // A `Field` is one number, implicitly in y; the reader warns that X values were
  // dropped, and 11 of the 582 files in the corpus carry a non-zero one. Comparing
  // only the y column would let a design Isaac cannot represent read as agreement.
  const offAxisX = prescription.fields.filter((field) => field.x !== 0);
  if (offAxisX.length > 0) {
    checks.text(
      section,
      'X field points',
      offAxisX.map((field) => formatNumber(field.x)).join(', '),
      'none: Isaac models Y fields only',
    );
  }

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
    // The report is in micrometres and the model in nanometres — and it *rounds*:
    // `0.587562` is the d line at 0.5875618, not a different wavelength. Compared
    // as an exact number it disagreed with a value printed identically.
    checks.value(
      section,
      `wavelength ${index + 1}`,
      parsePrescriptionValue(wavelength.umText, prescription.precision) ?? exactly(wavelength.um),
      own / 1000,
    );
  });
}

/**
 * The wavelength to compare at.
 *
 * The report rounds — `0.253` is three decimals of a micrometre — while the file
 * carries the value in full, so where the two agree the *file's* number is the
 * better one. Only when they genuinely differ does the report win, and then it
 * is the report the numbers were computed at.
 */
function comparisonWavelengthNm(system: OpticalSystem, prescription: ZmxPrescription): number {
  const reported = primaryWavelengthNm(prescription);
  if (reported === undefined) return system.primaryWavelengthNm;
  const stated = prescription.general.find((entry) => entry.label.startsWith('Primary Wavelength'));
  const printed =
    stated === undefined ? undefined : parsePrescriptionValue(stated.value, prescription.precision);
  if (printed !== undefined && valueContains(printed, system.primaryWavelengthNm / 1000)) {
    return system.primaryWavelengthNm;
  }
  return reported;
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
  const wavelengthNm = options.wavelengthNm ?? comparisonWavelengthNm(system, prescription);
  const checks = new Checks(options.relativeSlack ?? DEFAULT_SLACK);

  compareSurfaces(checks, system, prescription, wavelengthNm, warnings);
  compareAspheres(checks, system, prescription);
  compareSources(checks, system, prescription);
  compareGeneralData(checks, system, prescription, wavelengthNm);
  compareCardinalPoints(checks, system, prescription, wavelengthNm, warnings);

  return checks.done(warnings);
}
