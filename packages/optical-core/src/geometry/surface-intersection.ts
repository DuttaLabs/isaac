import { Point3 } from './point3.ts';
import { Vector3 } from './vector3.ts';

/** The result of intersecting a ray with a surface, in the surface's local frame. */
export interface SurfaceHit {
  /** Signed distance from the ray origin to the intersection. */
  distance: number;
  /** Intersection point in the surface's local frame (vertex at the origin). */
  point: Point3;
  /** Unit surface normal, pointing radially outward from the center of curvature. */
  normal: Vector3;
}

/**
 * Intersects a ray with a rotationally symmetric spherical (or plane) surface.
 *
 * Everything is expressed in the surface's **local frame**: the vertex is at the
 * origin and the optical axis is +Z. The sphere therefore passes through the
 * origin with its center of curvature at (0, 0, R), where R = 1 / curvature.
 *
 * Of the sphere's two intersections the physically correct one is the cap
 * nearest the vertex plane; the far side of the full sphere is discarded.
 *
 * @param origin    ray origin in the local frame
 * @param direction unit ray direction
 * @param curvature 1 / radius; use 0 for a plane
 * @returns the hit, or `null` if the ray does not meet the surface
 */
export function intersectSphericalSurface(
  origin: Point3,
  direction: Vector3,
  curvature: number,
): SurfaceHit | null {
  if (curvature === 0) {
    return intersectPlane(origin, direction);
  }

  const radius = 1 / curvature;
  const center = new Vector3(0, 0, radius);
  const oc = origin.toVector().subtract(center); // origin − center
  const b = direction.dot(oc);
  const c = oc.lengthSquared - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) {
    return null; // ray misses the sphere entirely
  }

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const tNear = -b - sqrtDiscriminant;
  const tFar = -b + sqrtDiscriminant;

  // Pick the root whose intersection lies nearest the vertex plane (z = 0);
  // that is the spherical cap, independent of the sign of the radius.
  const zNear = origin.z + direction.z * tNear;
  const zFar = origin.z + direction.z * tFar;
  const distance = Math.abs(zNear) <= Math.abs(zFar) ? tNear : tFar;

  const point = origin.add(direction.scale(distance));
  const normal = point.toVector().subtract(center).normalized();
  return { distance, point, normal };
}

/** Intersection with the plane z = 0 (normal along +Z). */
function intersectPlane(origin: Point3, direction: Vector3): SurfaceHit | null {
  if (direction.z === 0) {
    return null; // ray travels parallel to the plane
  }
  const distance = -origin.z / direction.z;
  const point = origin.add(direction.scale(distance));
  return { distance, point, normal: Vector3.unitZ() };
}
