import { Point3 } from '../geometry/point3.ts';
import { Vector3 } from '../geometry/vector3.ts';

/**
 * Lifecycle state of a ray as it propagates through a system.
 * - `ACTIVE`     — still propagating; more surfaces may be traced.
 * - `TERMINATED` — reached the image surface (or otherwise stopped normally).
 * - `BLOCKED`    — clipped by a surface aperture (semi-diameter).
 * - `MISSED`     — failed to intersect a surface it was expected to hit.
 * - `TIR`        — underwent total internal reflection at a refracting surface.
 */
export type RayStatus = 'ACTIVE' | 'TERMINATED' | 'BLOCKED' | 'MISSED' | 'TIR';

export interface RayOptions {
  /** Wavelength in nanometers. */
  wavelengthNm: number;
  /** Relative radiometric intensity in [0, ∞). Defaults to 1. */
  intensity?: number;
  /** Accumulated optical path length (geometric length × index) in system units. */
  /**
   * Optical path length accumulated so far, `Σ n·d`. May be negative where the
   * prescription steps backwards — see the constructor.
   */
  opticalPathLength?: number;
  /** Name of the material the ray is currently traveling through. Defaults to `AIR`. */
  medium?: string;
  status?: RayStatus;
}

export interface RayChanges extends Partial<RayOptions> {
  origin?: Point3;
  direction?: Vector3;
}

/**
 * An immutable geometric ray plus the physical bookkeeping needed for tracing.
 *
 * The direction is normalized at construction, so signed distances passed to
 * {@link Ray.at} are true lengths in system units.
 */
export class Ray {
  public readonly origin: Point3;
  public readonly direction: Vector3;
  public readonly wavelengthNm: number;
  public readonly intensity: number;
  public readonly opticalPathLength: number;
  public readonly medium: string;
  public readonly status: RayStatus;

  public constructor(origin: Point3, direction: Vector3, options: RayOptions) {
    if (!Number.isFinite(options.wavelengthNm) || options.wavelengthNm <= 0) {
      throw new RangeError('wavelengthNm must be a positive, finite number.');
    }
    const intensity = options.intensity ?? 1;
    const opticalPathLength = options.opticalPathLength ?? 0;
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw new RangeError('intensity must be a finite, non-negative number.');
    }
    // **Finite, but not necessarily positive.** Zero is the launch plane, and for
    // an object at infinity that plane is somewhere Isaac picked — "just in front
    // of the first surface" — so there is nothing physical about it to count up
    // from. A prescription that steps *backwards* then carries the running total
    // below it: a **remote stop** is written as a negative thickness, and the
    // surface it puts behind the one before it is reached along a negative
    // distance, which subtracts.
    //
    // `Yu2024.zmx` is the case that found this. Its surface 1 has a thickness of
    // -1, and an on-axis ray lands on exactly 0.00000000 after that step while a
    // ray at 1° lands on -0.00001031 — so the axis traced and every other field
    // threw, from a *lens* that is perfectly well formed. Refusing the negative
    // value turned a legitimate design into an internal invariant escaping where
    // the tracer should have been reporting an optical outcome.
    if (!Number.isFinite(opticalPathLength)) {
      throw new RangeError('opticalPathLength must be a finite number.');
    }

    this.origin = origin;
    this.direction = direction.normalized();
    this.wavelengthNm = options.wavelengthNm;
    this.intensity = intensity;
    this.opticalPathLength = opticalPathLength;
    this.medium = options.medium?.trim() || 'AIR';
    this.status = options.status ?? 'ACTIVE';
  }

  /** Point a signed distance along the ray from its origin. */
  public at(distance: number): Point3 {
    if (!Number.isFinite(distance)) {
      throw new TypeError('distance must be a finite number.');
    }
    return this.origin.add(this.direction.scale(distance));
  }

  /**
   * Returns a copy with selected changes applied. Any changed direction is
   * re-normalized. Physical bookkeeping (medium, OPL, intensity, status) is
   * carried forward unless explicitly overridden.
   */
  public with(changes: RayChanges): Ray {
    return new Ray(changes.origin ?? this.origin, changes.direction ?? this.direction, {
      wavelengthNm: changes.wavelengthNm ?? this.wavelengthNm,
      intensity: changes.intensity ?? this.intensity,
      opticalPathLength: changes.opticalPathLength ?? this.opticalPathLength,
      medium: changes.medium ?? this.medium,
      status: changes.status ?? this.status,
    });
  }
}
