import { Point3 } from './point3.ts';
import { Vector3 } from './vector3.ts';
import {
  type SurfaceShape,
  sphericalShape,
  surfaceSag,
  surfaceSlopeOverRadius,
  vertexCurvature,
} from './surface-sag.ts';

/** The result of intersecting a ray with a surface, in the surface's local frame. */
export interface SurfaceHit {
  /** Signed distance from the ray origin to the intersection. */
  distance: number;
  /** Intersection point in the surface's local frame (vertex at the origin). */
  point: Point3;
  /** Unit surface normal, pointing radially outward from the center of curvature. */
  normal: Vector3;
}

/** Newton stops here; a well-conditioned asphere converges in three or four steps. */
const MAX_REFINEMENTS = 32;

/**
 * Intersects a ray with a rotationally symmetric surface: plane, sphere, conic,
 * or even asphere.
 *
 * Everything is expressed in the surface's **local frame**: the vertex is at the
 * origin and the optical axis is +Z. The work is done in two stages, because the
 * two halves of the sag have very different characters. The conic base is a
 * quadric, so its intersection is a closed-form quadratic and needs no guessing.
 * The polynomial terms are not, so they are added by Newton iteration from that
 * exact conic hit — which is close enough that the residual sag is a small
 * correction and convergence is quick.
 *
 * @param origin    ray origin in the local frame
 * @param direction unit ray direction
 * @param shape     vertex curvature, conic constant, and aspheric coefficients
 * @returns the hit, or `null` if the ray does not meet the surface
 */
export function intersectSurface(
  origin: Point3,
  direction: Vector3,
  shape: SurfaceShape,
): SurfaceHit | null {
  const conicDistance = intersectConic(origin, direction, shape.curvature, shape.conic);

  const distance =
    shape.asphericCoefficients.length === 0
      ? conicDistance
      : refineOntoAsphere(
          origin,
          direction,
          shape,
          // Failing to meet the conic base does not mean missing the asphere: a
          // strong polynomial on a plane base has no conic to hit at all. The
          // vertex plane is always crossed by any ray with axial motion, so it
          // is the fallback starting point.
          conicDistance ?? planeDistance(origin, direction),
        );

  if (distance === null) {
    return null;
  }

  const point = origin.add(direction.scale(distance));
  const normal = normalAt(shape, point);
  return normal === null ? null : { distance, point, normal };
}

/**
 * Intersects a ray with a sphere or plane — {@link intersectSurface} for a shape
 * with no conic constant and no aspheric terms.
 *
 * @param curvature 1 / radius; use 0 for a plane
 */
export function intersectSphericalSurface(
  origin: Point3,
  direction: Vector3,
  curvature: number,
): SurfaceHit | null {
  return intersectSurface(origin, direction, sphericalShape(curvature));
}

/**
 * Distance along the ray to the conic base, or `null` if it never meets it.
 *
 * The conic `z = c·r²/(1 + √(1 − (1+k)c²r²))` is the quadric
 * `c·(x² + y² + (1+k)z²) − 2z = 0`, so substituting the ray gives an ordinary
 * quadratic in the distance. Of its two roots the physically correct one is the
 * sheet nearest the vertex plane; the far side of a closed conic, and the second
 * sheet of a hyperboloid, are discarded. A plane falls out as the case `c = 0`,
 * where the quadratic degenerates to a linear equation and the stable root
 * formula below returns its single root.
 */
function intersectConic(
  origin: Point3,
  direction: Vector3,
  curvature: number,
  conic: number,
): number | null {
  const o = origin.toVector();
  const a = curvature * (1 + conic * direction.z * direction.z);
  const b = 2 * (curvature * (o.dot(direction) + conic * origin.z * direction.z) - direction.z);
  const c = curvature * (o.lengthSquared + conic * origin.z * origin.z) - 2 * origin.z;

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null; // the ray misses the quadric entirely
  }

  // The textbook `(−b ± √D)/2a` loses the small root to cancellation when the
  // ray is nearly tangent to the axis, which is exactly the paraxial case every
  // system is dominated by. This form computes the large root first and gets the
  // small one by the product of the roots, and it degenerates gracefully: with
  // a = 0 the first root is infinite and the second is the linear root −c/b.
  const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(discriminant));
  return nearestToVertexPlane(origin, direction, q / a, c / q);
}

/** Distance to the plane z = 0, or `null` for a ray running parallel to it. */
function planeDistance(origin: Point3, direction: Vector3): number | null {
  return direction.z === 0 ? null : -origin.z / direction.z;
}

/**
 * Of two candidate distances, the one whose intersection lies nearest the vertex
 * plane. Infinite and undefined roots — the degenerate cases of the quadratic —
 * drop out because they never win the comparison.
 */
function nearestToVertexPlane(
  origin: Point3,
  direction: Vector3,
  first: number,
  second: number,
): number | null {
  const depth = (distance: number): number =>
    Number.isFinite(distance) ? Math.abs(origin.z + direction.z * distance) : Infinity;
  const firstDepth = depth(first);
  const secondDepth = depth(second);
  if (firstDepth === Infinity && secondDepth === Infinity) {
    return null;
  }
  return firstDepth <= secondDepth ? first : second;
}

/**
 * Newton iteration onto the full aspheric sag, starting from the conic hit.
 *
 * The residual is `z(t) − sag(r(t))` along the ray, whose derivative is
 * `dz − q·(x·dx + y·dy)` with `q` the slope-over-radius. Returns `null` if the
 * iterate wanders off the surface or fails to settle, which the tracer reads as
 * a miss — the honest report for a ray that cannot be brought onto the surface,
 * and better than a point that is merely near it.
 */
function refineOntoAsphere(
  origin: Point3,
  direction: Vector3,
  shape: SurfaceShape,
  start: number | null,
): number | null {
  if (start === null) {
    return null;
  }

  let distance = start;
  for (let step = 0; step < MAX_REFINEMENTS; step += 1) {
    const x = origin.x + direction.x * distance;
    const y = origin.y + direction.y * distance;
    const z = origin.z + direction.z * distance;
    const sag = surfaceSag(shape, Math.hypot(x, y));
    if (sag === null) {
      return null;
    }

    const residual = z - sag;
    // Scaled by the axial coordinate, so the test means the same thing for a
    // surface a millimetre from the origin and one a metre away.
    if (Math.abs(residual) <= 1e-12 * (1 + Math.abs(z))) {
      return distance;
    }

    const slopeOverRadius = surfaceSlopeOverRadius(shape, Math.hypot(x, y));
    if (slopeOverRadius === null) {
      return null;
    }
    const derivative = direction.z - slopeOverRadius * (x * direction.x + y * direction.y);
    if (derivative === 0) {
      return null; // the ray runs along the surface; no isolated crossing
    }

    distance -= residual / derivative;
    if (!Number.isFinite(distance)) {
      return null;
    }
  }
  return null;
}

/**
 * Unit normal at a point on the surface.
 *
 * The gradient of `z − sag(r)` is `(−x·q, −y·q, 1)`, which points along +Z at
 * the vertex. The project's convention is instead the sphere's — outward from
 * the center of curvature — and those two disagree by a sign exactly when the
 * center lies toward +Z, so the gradient is flipped for a positive curvature.
 * A plane keeps +Z, and a negative curvature already agrees.
 *
 * The curvature that decides it is the *vertex* curvature, `c + 2α₁`, not the
 * base radius: the same parabola can be written as a conic on a curved base or
 * as a polynomial on a flat one, and a rule reading the base alone would hand
 * back opposite normals for the two spellings of one surface. Refraction and
 * reflection are both indifferent to which end of the normal is which, so this
 * governs what a consumer of `Intersection.normal` sees, not the trace itself.
 */
function normalAt(shape: SurfaceShape, point: Point3): Vector3 | null {
  const slopeOverRadius = surfaceSlopeOverRadius(shape, Math.hypot(point.x, point.y));
  if (slopeOverRadius === null) {
    return null;
  }
  const gradient = new Vector3(
    -point.x * slopeOverRadius,
    -point.y * slopeOverRadius,
    1,
  ).normalized();
  return vertexCurvature(shape) > 0 ? gradient.negate() : gradient;
}
