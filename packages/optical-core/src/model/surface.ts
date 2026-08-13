import { AIR, type Material } from "./material.ts";

/**
 * Surface types understood by the sequential tracer.
 *
 * Only the three foundational types exist for now; ASPHERIC, COORDINATE_BREAK,
 * MIRROR, and other Zemax-compatible types are planned but intentionally absent.
 */
export type SurfaceType = "OBJECT" | "STANDARD" | "IMAGE";

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
  /** Medium immediately after the surface (toward +Z). */
  public readonly material: Material;
  public readonly reflective: boolean;
  /** True when this surface is the system's aperture stop. */
  public readonly isStop: boolean;
  public readonly comment: string | undefined;

  public constructor(config: SurfaceConfig) {
    if (!config.id) {
      throw new TypeError("Surface requires a non-empty id.");
    }
    const radius = config.radius ?? Infinity;
    if (Number.isNaN(radius) || radius === 0) {
      throw new RangeError("Surface radius must be non-zero (use Infinity for a plane).");
    }
    if (!Number.isFinite(config.thickness)) {
      // Object thickness may be Infinity (object at infinity); everything else must be finite.
      if (!(config.type === "OBJECT" && config.thickness === Infinity)) {
        throw new RangeError("Surface thickness must be finite (except an OBJECT at infinity).");
      }
    }
    const semiDiameter = config.semiDiameter ?? Infinity;
    if (Number.isNaN(semiDiameter) || semiDiameter <= 0) {
      throw new RangeError("semiDiameter must be a positive number (or Infinity for no aperture).");
    }

    this.id = config.id;
    this.type = config.type;
    this.radius = radius;
    this.thickness = config.thickness;
    this.semiDiameter = semiDiameter;
    this.material = config.material ?? AIR;
    this.reflective = config.reflective ?? false;
    this.isStop = config.isStop ?? false;
    if (this.isStop && config.type !== 'STANDARD') {
      throw new RangeError('Only a STANDARD surface can be the aperture stop.');
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
