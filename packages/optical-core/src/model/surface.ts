import { AIR, type Material } from './material.ts';
import { Transform3 } from '../geometry/transform3.ts';
import { Vector3 } from '../geometry/vector3.ts';
import {
  type SurfaceShape,
  maximumSagRadius,
  surfaceProfileSag,
  vertexCurvature,
} from '../geometry/surface-sag.ts';

/**
 * Surface types understood by the sequential tracer.
 *
 * `STANDARD` covers planes, spheres and conics — the same grouping Zemax uses,
 * and for the same reason: a conic is a change of shape, not of kind, and every
 * one of them is a quadric the tracer solves in closed form. `EVEN_ASPHERE`
 * adds the even-power polynomial terms on top of that conic, which is the
 * surface almost every molded plastic lens is described by.
 *
 * `PARAXIAL` is an ideal thin lens: a plane that bends rays by the paraxial law
 * alone, with no glass and no aberration. Designers use it as a placeholder for
 * a lens group not yet designed, so it is a modeling element rather than a
 * manufacturable surface.
 *
 * `COORDINATE_TRANSFORM` is not a surface at all: it carries no glass and no shape,
 * meets no ray, and exists only to re-point the axis for everything after it.
 * It is how a fold mirror, a tilted element or a decentered group is expressed.
 * TOROIDAL and other Zemax-compatible types are planned but intentionally absent.
 */
export type SurfaceType =
  'OBJECT' | 'STANDARD' | 'EVEN_ASPHERE' | 'PARAXIAL' | 'COORDINATE_TRANSFORM' | 'IMAGE';

/** The types that may carry aspheric polynomial coefficients. */
export const ASPHERIC_SURFACE_TYPES: readonly SurfaceType[] = ['EVEN_ASPHERE'];

/**
 * The types allowed to carry the system's aperture stop — the surfaces that
 * bend rays and so define a pupil, as opposed to the two ends of the system.
 * Exported so readers and editors test the same rule the constructor enforces.
 */
export const STOP_CAPABLE_SURFACE_TYPES: readonly SurfaceType[] = [
  'STANDARD',
  'EVEN_ASPHERE',
  'PARAXIAL',
];

/**
 * The decenter and tilt a {@link SurfaceType} of `COORDINATE_TRANSFORM` applies to
 * everything downstream of it. Angles are in **degrees**, right-handed about
 * the positive axes, and relative to the frame the previous surface left behind
 * — the convention Zemax defines and every `.zmx` file is written in.
 *
 * `tiltFirst` is Zemax's order flag, and the order genuinely matters because
 * rotations do not commute with translations. False (the file's `0`, and the
 * common case) decenters in x and y, then tilts about local x, then about the
 * *new* y, then about the *new* z. True reverses both halves: tilts about z,
 * then new y, then new x, and only then decenters — which is what lets one
 * transform exactly undo another, by negating all five numbers and flipping this
 * flag. The thickness is applied last either way, along the axis as re-pointed.
 */
export interface CoordinateTransform {
  /** Decenter along local x, in system units. */
  decenterX: number;
  /** Decenter along local y, in system units. */
  decenterY: number;
  /** Tilt about local x, in degrees. */
  tiltXDeg: number;
  /** Tilt about local y, in degrees. */
  tiltYDeg: number;
  /** Tilt about local z, in degrees. */
  tiltZDeg: number;
  /** When true, tilt before decentering (Zemax's order flag ≠ 0). */
  tiltFirst: boolean;
}

export interface SurfaceConfig {
  /** Stable identifier (e.g. a UUID from the editor). */
  id: string;
  type: SurfaceType;
  /**
   * Radius of curvature in system units. Use `Infinity` for a plane.
   * Sign convention: positive radius places the center of curvature toward +Z.
   */
  radius?: number;
  /**
   * Conic constant `k`: 0 a sphere, −1 a paraboloid, below −1 a hyperboloid,
   * between −1 and 0 a prolate ellipsoid, above 0 an oblate ellipsoid. Allowed
   * on any surface that has a radius, and rejected on a `PARAXIAL` surface,
   * which is a plane by definition.
   */
  conic?: number;
  /**
   * `α₁…αₙ`, the aspheric coefficients on r², r⁴, … r^(2n), in the units that
   * makes each term a length. Only an `EVEN_ASPHERE` surface accepts them.
   */
  asphericCoefficients?: readonly number[];
  /** Axial distance to the next surface, in system units. */
  thickness: number;
  /** Clear-aperture semi-diameter. Rays beyond this radius are blocked. */
  semiDiameter?: number;
  /**
   * Focal length of the ideal thin lens, for `PARAXIAL` surfaces only, where it
   * replaces the radius as the source of the surface's power (φ = 1/focalLength).
   * Required on a `PARAXIAL` surface and rejected on every other type.
   */
  focalLength?: number;
  /**
   * The decenter and tilt applied by a `COORDINATE_TRANSFORM` surface. Required on
   * one, and rejected on every other type — a tilt has no meaning on a surface
   * that also has a shape, which is the one thing this type does not have.
   */
  coordinateTransform?: CoordinateTransform;
  /** Medium immediately after this surface (toward +Z). Defaults to AIR. */
  material?: Material;
  /**
   * When true the surface reflects instead of refracts (a mirror). The medium
   * is unchanged across a reflection.
   */
  reflective?: boolean;
  /**
   * Marks this surface as the aperture stop. A system has at most one stop; it
   * defines the entrance and exit pupils that ray aiming and field analysis use.
   */
  isStop?: boolean;
  comment?: string;
}

/**
 * A single rotationally symmetric optical surface. Surfaces are
 * position-independent; their global vertex location is derived from the
 * cumulative thicknesses held by the {@link OpticalSystem}.
 */
export class Surface {
  public readonly id: string;
  public readonly type: SurfaceType;
  /** Radius of curvature; `Infinity` for a plane. */
  public readonly radius: number;
  /** Conic constant; 0 for a sphere or a plane. */
  public readonly conic: number;
  /** `α₁…αₙ` on r², r⁴, …; empty unless this is an `EVEN_ASPHERE`. */
  public readonly asphericCoefficients: readonly number[];
  public readonly thickness: number;
  public readonly semiDiameter: number;
  /** Ideal-lens focal length; defined only on a `PARAXIAL` surface. */
  public readonly focalLength: number | undefined;
  /** Decenter and tilt; defined only on a `COORDINATE_TRANSFORM` surface. */
  public readonly coordinateTransform: CoordinateTransform | undefined;
  /** Medium immediately after the surface (toward +Z). */
  public readonly material: Material;
  public readonly reflective: boolean;
  /** True when this surface is the system's aperture stop. */
  public readonly isStop: boolean;
  public readonly comment: string | undefined;
  /**
   * Curvature, conic and coefficients as the geometry layer wants them. Built
   * once, in the constructor, because the tracer reads it for every ray at every
   * surface and a fresh object per intersection would be the hot loop's largest
   * cost.
   */
  public readonly shape: SurfaceShape;

  public constructor(config: SurfaceConfig) {
    if (!config.id) {
      throw new TypeError('Surface requires a non-empty id.');
    }
    const radius = config.radius ?? Infinity;
    if (Number.isNaN(radius) || radius === 0) {
      throw new RangeError('Surface radius must be non-zero (use Infinity for a plane).');
    }
    if (!Number.isFinite(config.thickness)) {
      // Object thickness may be Infinity (object at infinity); everything else must be finite.
      if (!(config.type === 'OBJECT' && config.thickness === Infinity)) {
        throw new RangeError('Surface thickness must be finite (except an OBJECT at infinity).');
      }
    }
    const semiDiameter = config.semiDiameter ?? Infinity;
    if (Number.isNaN(semiDiameter) || semiDiameter <= 0) {
      throw new RangeError('semiDiameter must be a positive number (or Infinity for no aperture).');
    }

    const conic = config.conic ?? 0;
    if (!Number.isFinite(conic)) {
      throw new RangeError('Conic constant must be a finite number.');
    }
    const asphericCoefficients = normalizeCoefficients(config.asphericCoefficients);

    // A PARAXIAL surface takes its power from focalLength, so a radius would be
    // a second, contradictory source of the same thing; reject rather than ignore.
    if (config.type === 'PARAXIAL') {
      if (config.focalLength === undefined) {
        throw new TypeError('A PARAXIAL surface requires a focalLength.');
      }
      if (!Number.isFinite(config.focalLength) || config.focalLength === 0) {
        throw new RangeError('PARAXIAL focalLength must be finite and non-zero.');
      }
      if (Number.isFinite(radius)) {
        throw new RangeError(
          'A PARAXIAL surface is a plane; its power comes from focalLength, not a radius.',
        );
      }
      if (conic !== 0) {
        throw new RangeError('A PARAXIAL surface is a plane; it cannot have a conic constant.');
      }
      if (config.reflective) {
        throw new RangeError('A PARAXIAL surface cannot be reflective.');
      }
    } else if (config.focalLength !== undefined) {
      throw new RangeError('focalLength is only meaningful on a PARAXIAL surface.');
    }

    // A coordinate transform has no shape, no glass boundary and no aperture: it is
    // a change of frame wearing a surface's clothes. Anything that would give it
    // optical behavior is refused rather than ignored, because a tilted surface
    // that also refracts is a different feature (Zemax's surface tilt/decenter)
    // and silently accepting one here would trace as neither.
    if (config.type === 'COORDINATE_TRANSFORM') {
      if (config.coordinateTransform === undefined) {
        throw new TypeError('A COORDINATE_TRANSFORM surface requires its decenters and tilts.');
      }
      for (const [key, value] of Object.entries(config.coordinateTransform)) {
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new RangeError(`COORDINATE_TRANSFORM ${key} must be a finite number.`);
        }
      }
      if (Number.isFinite(radius)) {
        throw new RangeError('A COORDINATE_TRANSFORM has no shape, so it cannot have a radius.');
      }
      if (conic !== 0) {
        throw new RangeError(
          'A COORDINATE_TRANSFORM has no shape, so it cannot have a conic constant.',
        );
      }
      if (config.reflective) {
        // The Zemax manual is explicit that this surface can never be a mirror.
        // A fold is three surfaces: a transform, a mirror, and a transform back.
        throw new RangeError(
          'A COORDINATE_TRANSFORM cannot be a mirror; put the mirror on its own surface.',
        );
      }
      if (config.semiDiameter !== undefined && Number.isFinite(config.semiDiameter)) {
        throw new RangeError(
          'A COORDINATE_TRANSFORM meets no ray, so it cannot have a clear aperture.',
        );
      }
    } else if (config.coordinateTransform !== undefined) {
      throw new RangeError(
        'coordinateTransform is only meaningful on a COORDINATE_TRANSFORM surface.',
      );
    }

    // Coefficients are what distinguishes an EVEN_ASPHERE from a STANDARD
    // surface, so accepting them anywhere else would leave two surfaces of the
    // same declared type tracing as different shapes.
    if (asphericCoefficients.length > 0 && !ASPHERIC_SURFACE_TYPES.includes(config.type)) {
      throw new RangeError(
        `Aspheric coefficients are only meaningful on an ${listTypes(ASPHERIC_SURFACE_TYPES)} ` +
          `surface, not a ${config.type} one.`,
      );
    }

    this.id = config.id;
    this.type = config.type;
    this.radius = radius;
    this.conic = conic;
    this.asphericCoefficients = asphericCoefficients;
    this.focalLength = config.focalLength;
    this.coordinateTransform = config.coordinateTransform;
    this.thickness = config.thickness;
    this.semiDiameter = semiDiameter;
    this.material = config.material ?? AIR;
    this.reflective = config.reflective ?? false;
    this.isStop = config.isStop ?? false;
    if (this.isStop && !STOP_CAPABLE_SURFACE_TYPES.includes(config.type)) {
      throw new RangeError(
        `Only a ${listTypes(STOP_CAPABLE_SURFACE_TYPES)} surface can be the aperture stop.`,
      );
    }
    this.comment = config.comment;
    this.shape = Object.freeze({
      curvature: Number.isFinite(radius) ? 1 / radius : 0,
      conic,
      asphericCoefficients,
    });
  }

  /** Returns a copy with selected changes applied; the original is untouched. */
  public with(changes: Partial<SurfaceConfig>): Surface {
    return new Surface({
      id: changes.id ?? this.id,
      type: changes.type ?? this.type,
      radius: changes.radius ?? this.radius,
      conic: changes.conic ?? this.conic,
      asphericCoefficients: changes.asphericCoefficients ?? this.asphericCoefficients,
      thickness: changes.thickness ?? this.thickness,
      semiDiameter: changes.semiDiameter ?? this.semiDiameter,
      focalLength: changes.focalLength ?? this.focalLength,
      coordinateTransform: changes.coordinateTransform ?? this.coordinateTransform,
      material: changes.material ?? this.material,
      reflective: changes.reflective ?? this.reflective,
      isStop: changes.isStop ?? this.isStop,
      comment: changes.comment ?? this.comment,
    });
  }

  /** Vertex curvature (1/radius); zero for a plane. */
  public get curvature(): number {
    return this.shape.curvature;
  }

  /**
   * Curvature a paraxial ray sees, `c + 2α₁` — the base curvature unless an
   * aspheric r² term is shifting it. Surface power is derived from this, never
   * from `curvature` directly.
   */
  public get paraxialCurvature(): number {
    return vertexCurvature(this.shape);
  }

  public get isPlane(): boolean {
    return !Number.isFinite(this.radius) && this.conic === 0 && !this.hasAsphericTerms;
  }

  /** True when a polynomial term actually departs from the conic base. */
  public get hasAsphericTerms(): boolean {
    return this.asphericCoefficients.length > 0;
  }

  /** Axial sag at transverse height `r`, held at the rim past a closing conic. */
  public sagAt(r: number): number {
    return surfaceProfileSag(this.shape, r);
  }

  /** Largest radius at which the surface exists; `Infinity` unless the conic closes. */
  public get maximumRadius(): number {
    return maximumSagRadius(this.shape);
  }

  /**
   * The change of frame this surface makes for everything after it. Identity
   * for every surface except a coordinate transform, which is the only thing in the
   * model that can move the axis.
   *
   * Built here rather than in `OpticalSystem` so the rule lives with the type
   * that owns it, and the axial walk stays a plain composition.
   */
  public get frameChange(): Transform3 {
    const parameters = this.coordinateTransform;
    if (parameters === undefined) {
      return Transform3.identity();
    }

    const { decenterX, decenterY, tiltXDeg, tiltYDeg, tiltZDeg, tiltFirst } = parameters;
    const decenter = Transform3.translation(new Vector3(decenterX, decenterY, 0));
    const x = Transform3.rotationX(toRadians(tiltXDeg));
    const y = Transform3.rotationY(toRadians(tiltYDeg));
    const z = Transform3.rotationZ(toRadians(tiltZDeg));

    // Each tilt is about the axes the previous tilt left, so they compose
    // innermost-last: x then new-y then new-z reads as Rx·Ry·Rz. Reversing the
    // flag reverses both the tilt order and which side the decenter sits on,
    // which is exactly what makes one transform the inverse of another.
    return tiltFirst
      ? z.compose(y).compose(x).compose(decenter)
      : decenter.compose(x).compose(y).compose(z);
  }
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** `A, B or C` — for error messages that name a set of allowed surface types. */
function listTypes(types: readonly SurfaceType[]): string {
  return types.length < 2
    ? (types[0] ?? '')
    : `${types.slice(0, -1).join(', ')} or ${types[types.length - 1]}`;
}

/**
 * Validates the coefficients and drops trailing zeros.
 *
 * Trimming makes the empty list mean exactly "no polynomial", which the tracer
 * tests to take the closed-form conic path, and keeps a surface written out with
 * Zemax's full eight parameter columns from being treated as more complicated
 * than it is. Interior zeros are kept: they are positions in the series, and
 * `[0, 0, α₃]` is a real and common shape.
 */
function normalizeCoefficients(coefficients: readonly number[] | undefined): readonly number[] {
  if (coefficients === undefined) {
    return EMPTY_COEFFICIENTS;
  }
  for (const coefficient of coefficients) {
    if (!Number.isFinite(coefficient)) {
      throw new RangeError('Aspheric coefficients must be finite numbers.');
    }
  }
  let end = coefficients.length;
  while (end > 0 && coefficients[end - 1] === 0) {
    end -= 1;
  }
  return end === 0 ? EMPTY_COEFFICIENTS : Object.freeze(coefficients.slice(0, end));
}

const EMPTY_COEFFICIENTS: readonly number[] = Object.freeze([]);
