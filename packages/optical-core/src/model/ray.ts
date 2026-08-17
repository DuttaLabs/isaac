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
    if (!Number.isFinite(opticalPathLength) || opticalPathLength < 0) {
      throw new RangeError('opticalPathLength must be a finite, non-negative number.');
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
