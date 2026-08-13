import { Vector3 } from '../geometry/vector3.ts';

/**
 * Refraction by the vector form of Snell's law.
 *
 * @param direction incident unit direction
 * @param normal    unit surface normal (either orientation is accepted; it is
 *                  flipped internally to oppose the incident ray)
 * @param n1        refractive index of the medium the ray is leaving
 * @param n2        refractive index of the medium the ray is entering
 * @returns the refracted unit direction, or `null` under total internal reflection
 */
export function refract(
  direction: Vector3,
  normal: Vector3,
  n1: number,
  n2: number,
): Vector3 | null {
  const oriented = orientAgainst(direction, normal);
  const cosThetaI = -direction.dot(oriented); // ≥ 0 by construction
  const eta = n1 / n2;
  const sinThetaTSquared = eta * eta * (1 - cosThetaI * cosThetaI);
  if (sinThetaTSquared > 1) {
    return null; // total internal reflection
  }
  const cosThetaT = Math.sqrt(1 - sinThetaTSquared);
  return direction
    .scale(eta)
    .add(oriented.scale(eta * cosThetaI - cosThetaT))
    .normalized();
}

/** Mirror reflection of an incident unit direction about a surface normal. */
export function reflect(direction: Vector3, normal: Vector3): Vector3 {
  return direction.subtract(normal.scale(2 * direction.dot(normal))).normalized();
}

/** Angle of incidence (radians, in [0, π/2]) between a ray and a surface normal. */
export function angleOfIncidence(direction: Vector3, normal: Vector3): number {
  const cos = Math.min(1, Math.abs(direction.dot(normal)));
  return Math.acos(cos);
}

/** Returns `normal` flipped, if necessary, so it points against the ray. */
function orientAgainst(direction: Vector3, normal: Vector3): Vector3 {
  return direction.dot(normal) > 0 ? normal.negate() : normal;
}
