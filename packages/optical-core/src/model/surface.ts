import { AIR, type Material } from './material.ts';

/**
 * Surface types understood by the sequential tracer.
 *
 * `PARAXIAL` is an ideal thin lens: a plane that bends rays by the paraxial law
 * alone, with no glass and no aberration. Designers use it as a placeholder for
 * a lens group not yet designed, so it is a modelling element rather than a
 * manufacturable surface. ASPHERIC, COORDINATE_BREAK, MIRROR, and other
 * Zemax-compatible types are planned but intentionally absent.
 */
export type SurfaceType = 'OBJECT' | 'STANDARD' | 'PARAXIAL' | 'IMAGE';

export interface SurfaceConfig {
  /** Stable identifier (e.g. a UUID from the editor). */
  id: string;
  type: SurfaceType;
  /**
   * Radius of curvature in system units. Use `Infinity` for a plane.
   * Sign convention: positive radius places the centre of curvature toward +Z.
   */
  radius?: number;
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
  public readonly thickness: number;
  public readonly semiDiameter: number;
  /** Ideal-lens focal length; defined only on a `PARAXIAL` surface. */
  public readonly focalLength: number | undefined;
  /** Medium immediately after the surface (toward +Z). */
  public readonly material: Material;
  public readonly reflective: boolean;
  /** True when this surface is the system's aperture stop. */
  public readonly isStop: boolean;
  public readonly comment: string | undefined;

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
      if (config.reflective) {
        throw new RangeError('A PARAXIAL surface cannot be reflective.');
      }
    } else if (config.focalLength !== undefined) {
      throw new RangeError('focalLength is only meaningful on a PARAXIAL surface.');
    }

    this.id = config.id;
    this.type = config.type;
    this.radius = radius;
    this.focalLength = config.focalLength;
    this.thickness = config.thickness;
    this.semiDiameter = semiDiameter;
    this.material = config.material ?? AIR;
    this.reflective = config.reflective ?? false;
    this.isStop = config.isStop ?? false;
    if (this.isStop && config.type !== 'STANDARD' && config.type !== 'PARAXIAL') {
      throw new RangeError('Only a STANDARD or PARAXIAL surface can be the aperture stop.');
    }
    this.comment = config.comment;
  }

  /** Returns a copy with selected changes applied; the original is untouched. */
  public with(changes: Partial<SurfaceConfig>): Surface {
    return new Surface({
      id: changes.id ?? this.id,
      type: changes.type ?? this.type,
      radius: changes.radius ?? this.radius,
      thickness: changes.thickness ?? this.thickness,
      semiDiameter: changes.semiDiameter ?? this.semiDiameter,
      focalLength: changes.focalLength ?? this.focalLength,
      material: changes.material ?? this.material,
      reflective: changes.reflective ?? this.reflective,
      isStop: changes.isStop ?? this.isStop,
      comment: changes.comment ?? this.comment,
    });
  }

  /** Curvature (1/radius); zero for a plane. */
  public get curvature(): number {
    return Number.isFinite(this.radius) ? 1 / this.radius : 0;
  }

  public get isPlane(): boolean {
    return !Number.isFinite(this.radius);
  }
}
