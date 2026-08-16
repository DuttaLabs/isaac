import { Point3 } from '../geometry/point3.ts';
import { Vector3 } from '../geometry/vector3.ts';
import { intersectSphericalSurface } from '../geometry/surface-intersection.ts';
import type { OpticalSystem } from '../model/optical-system.ts';
import { Ray, type RayStatus } from '../model/ray.ts';
import type { Surface } from '../model/surface.ts';
import { angleOfIncidence, reflect, refract } from './optics.ts';
import { surfacePower } from './paraxial.ts';

/** What happened to the ray at one surface. */
export type InteractionKind = 'REFRACT' | 'REFLECT' | 'RECORD' | 'PARAXIAL';

/** A single ray–surface interaction, carrying everything a visualizer needs. */
export interface Intersection {
  surfaceIndex: number;
  surfaceId: string;
  /** Intersection point in global coordinates. */
  point: Point3;
  /** Unit surface normal (global), pointing outward from the centre of curvature. */
  normal: Vector3;
  /** Unit ray direction arriving at the surface. */
  incomingDirection: Vector3;
  /** Unit ray direction leaving the surface. */
  outgoingDirection: Vector3;
  /** Geometric distance travelled from the previous point to this one. */
  distance: number;
  /** Refractive index before / after the interaction. */
  indexBefore: number;
  indexAfter: number;
  /** Angle of incidence in radians. */
  angleOfIncidenceRad: number;
  kind: InteractionKind;
}

export interface RayTraceResult {
  inputRay: Ray;
  /** Ray state after the last successful interaction. */
  finalRay: Ray;
  intersections: Intersection[];
  status: RayStatus;
  /** Index of the surface where tracing stopped, if it stopped early. */
  terminatedAtSurface?: number;
}

const DISTANCE_EPSILON = 1e-9;

/**
 * Traces a single ray sequentially through the surfaces of a system.
 *
 * The ray is given in global coordinates. Surfaces are visited in order,
 * starting after the OBJECT surface. At each surface the ray is intersected,
 * clipped against the clear aperture, and then refracted (or reflected, or
 * simply recorded at the image plane). Tracing stops at the IMAGE surface or at
 * the first failure (missed surface, blocked aperture, or total internal
 * reflection).
 */
export function traceRay(system: OpticalSystem, inputRay: Ray): RayTraceResult {
  const wavelengthNm = inputRay.wavelengthNm;
  const intersections: Intersection[] = [];
  let ray = inputRay;

  for (let index = 1; index < system.surfaces.length; index += 1) {
    const surface = system.surfaceAt(index);
    const vertexZ = system.vertexZAt(index);

    // Move into the surface's local frame (pure axial translation for now).
    const localOrigin = new Point3(ray.origin.x, ray.origin.y, ray.origin.z - vertexZ);
    const hit = intersectSphericalSurface(localOrigin, ray.direction, surface.curvature);

    if (hit === null || hit.distance < -DISTANCE_EPSILON) {
      return finish(inputRay, ray, intersections, 'MISSED', index);
    }

    const point = new Point3(hit.point.x, hit.point.y, hit.point.z + vertexZ);

    // Clip against the clear aperture (semi-diameter).
    const radial = Math.hypot(point.x, point.y);
    if (radial > surface.semiDiameter + DISTANCE_EPSILON) {
      ray = ray.with({ origin: point, status: 'BLOCKED' });
      return finish(inputRay, ray, intersections, 'BLOCKED', index);
    }

    // Optical path length accrues in the medium just traversed.
    const indexBefore = system.surfaceAt(index - 1).material.indexAt(wavelengthNm);
    const opticalPathLength = ray.opticalPathLength + hit.distance * indexBefore;
    const incoming = ray.direction;
    const aoi = angleOfIncidence(incoming, hit.normal);

    const outcome = interact(surface, incoming, hit.normal, indexBefore, wavelengthNm, hit.point);
    if (outcome.status === 'TIR') {
      intersections.push({
        surfaceIndex: index,
        surfaceId: surface.id,
        point,
        normal: hit.normal,
        incomingDirection: incoming,
        outgoingDirection: incoming,
        distance: hit.distance,
        indexBefore,
        indexAfter: indexBefore,
        angleOfIncidenceRad: aoi,
        kind: 'REFLECT',
      });
      ray = ray.with({ origin: point, opticalPathLength, status: 'TIR' });
      return finish(inputRay, ray, intersections, 'TIR', index);
    }

    intersections.push({
      surfaceIndex: index,
      surfaceId: surface.id,
      point,
      normal: hit.normal,
      incomingDirection: incoming,
      outgoingDirection: outcome.direction,
      distance: hit.distance,
      indexBefore,
      indexAfter: outcome.indexAfter,
      angleOfIncidenceRad: aoi,
      kind: outcome.kind,
    });

    const reachedImage = surface.type === 'IMAGE';
    ray = ray.with({
      origin: point,
      direction: outcome.direction,
      medium: outcome.medium,
      opticalPathLength,
      status: reachedImage ? 'TERMINATED' : 'ACTIVE',
    });

    if (reachedImage) {
      return finish(inputRay, ray, intersections, 'TERMINATED', index);
    }
  }

  // A well-formed system always ends on an IMAGE surface; reaching here means none was found.
  return finish(inputRay, ray, intersections, 'TERMINATED');
}

interface Interaction {
  status: 'OK' | 'TIR';
  direction: Vector3;
  medium: string;
  indexAfter: number;
  kind: InteractionKind;
}

/** Decides what the ray does at a surface: record, bend ideally, reflect, or refract. */
function interact(
  surface: Surface,
  incoming: Vector3,
  normal: Vector3,
  indexBefore: number,
  wavelengthNm: number,
  localPoint: Point3,
): Interaction {
  if (surface.type === 'IMAGE') {
    return {
      status: 'OK',
      direction: incoming,
      medium: surface.material.name,
      indexAfter: indexBefore,
      kind: 'RECORD',
    };
  }

  if (surface.type === 'PARAXIAL') {
    const indexAfter = surface.material.indexAt(wavelengthNm);
    return {
      status: 'OK',
      direction: bendIdeally(surface, incoming, localPoint, indexBefore, indexAfter),
      medium: surface.material.name,
      indexAfter,
      kind: 'PARAXIAL',
    };
  }

  if (surface.reflective) {
    return {
      status: 'OK',
      direction: reflect(incoming, normal),
      medium: surface.material.name,
      indexAfter: indexBefore,
      kind: 'REFLECT',
    };
  }

  const indexAfter = surface.material.indexAt(wavelengthNm);
  const refracted = refract(incoming, normal, indexBefore, indexAfter);
  if (refracted === null) {
    return {
      status: 'TIR',
      direction: incoming,
      medium: surface.material.name,
      indexAfter,
      kind: 'REFLECT',
    };
  }
  return {
    status: 'OK',
    direction: refracted,
    medium: surface.material.name,
    indexAfter,
    kind: 'REFRACT',
  };
}

/**
 * Bends a ray at an ideal thin lens: `n'u' = nu − yφ` applied to the ray's two
 * transverse slopes, about the surface's local origin.
 *
 * Working in slopes (dx/dz, dy/dz) rather than direction cosines is what makes
 * the surface *ideal*. A collimated bundle arriving at slope u leaves at slope
 * `u − xφ` from height x, and at distance f = 1/φ every one of those rays has
 * reached height `u·f` whatever x was — a perfect point image at any aperture.
 * That is the whole purpose of a placeholder lens: contribute first-order power
 * and no aberration. A direction-cosine formulation would instead introduce a
 * spherical-aberration-like residual that is an artefact of the formula rather
 * than a property of the design.
 */
function bendIdeally(
  surface: Surface,
  incoming: Vector3,
  localPoint: Point3,
  indexBefore: number,
  indexAfter: number,
): Vector3 {
  const power = surfacePower(surface, indexBefore, indexAfter);
  // Slopes are unchanged by the ray's direction of travel; only the axial
  // component's sign records which way it is going, so re-attach it at the end.
  const slopeX = incoming.x / incoming.z;
  const slopeY = incoming.y / incoming.z;
  const outSlopeX = (indexBefore * slopeX - localPoint.x * power) / indexAfter;
  const outSlopeY = (indexBefore * slopeY - localPoint.y * power) / indexAfter;
  const direction = new Vector3(outSlopeX, outSlopeY, 1).normalized();
  return incoming.z < 0 ? direction.scale(-1) : direction;
}

function finish(
  inputRay: Ray,
  finalRay: Ray,
  intersections: Intersection[],
  status: RayStatus,
  terminatedAtSurface?: number,
): RayTraceResult {
  return terminatedAtSurface === undefined
    ? { inputRay, finalRay, intersections, status }
    : { inputRay, finalRay, intersections, status, terminatedAtSurface };
}
