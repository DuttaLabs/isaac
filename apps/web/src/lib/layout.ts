import type { OpticalSystem, RayTraceResult } from '@isaac/optical-core';

/** A point in system coordinates: z along the axis, y transverse. */
export interface LayoutPoint {
  z: number;
  y: number;
}

export interface SurfaceProfile {
  surfaceIndex: number;
  points: LayoutPoint[];
  isStop: boolean;
  isImage: boolean;
}

export interface GlassBody {
  /** Closed outline: front surface forwards, rear surface backwards. */
  points: LayoutPoint[];
  /** The surfaces the glass runs between, for naming the element to the user. */
  frontIndex: number;
  backIndex: number;
  /**
   * The rim-to-rim segments closing the outline top and bottom — the ground
   * edge of the element. They slope when the two surfaces have unequal
   * semi-diameters, which is what a lens with a stepped edge really looks like
   * in cross-section.
   */
  topEdge: [LayoutPoint, LayoutPoint];
  bottomEdge: [LayoutPoint, LayoutPoint];
  /**
   * Least axial gap between the two surfaces across the aperture they share.
   * Negative means the rear surface has crossed in front of the front one.
   */
  leastGap: number;
  /** `leastGap < 0`: the element cannot be made as specified. */
  crossed: boolean;
}

export interface LayoutGeometry {
  profiles: SurfaceProfile[];
  bodies: GlassBody[];
  rayPaths: { points: LayoutPoint[]; wavelengthIndex: number; blocked: boolean }[];
  bounds: { minZ: number; maxZ: number; minY: number; maxY: number };
}

const PROFILE_SAMPLES = 33;

/** Axial sag of a spherical surface at transverse height `y`. */
export function sag(curvature: number, y: number): number {
  if (curvature === 0) {
    return 0;
  }
  const term = 1 - curvature * curvature * y * y;
  if (term <= 0) {
    return 1 / curvature;
  }
  return (curvature * y * y) / (1 + Math.sqrt(term));
}

/**
 * Least axial distance between two consecutive surfaces, over the aperture they
 * share. Negative means the rear surface has crossed in front of the front one:
 * the element would have to be thinner than nothing somewhere, which is a real
 * design fault, not a drawing artefact. It is the usual failure of a strongly
 * curved element whose semi-diameter has been opened up past what its centre
 * thickness can support, and it shows up first at the edge of the aperture.
 *
 * Sampled rather than solved: the extremum of the gap is at the axis or the rim
 * for the shapes met in practice, but not in general, and sampling on the same
 * grid the profiles are drawn on keeps the verdict consistent with the picture.
 *
 * The shared aperture is `min` of the two semi-diameters — where both surfaces
 * actually exist. Past that only one surface is present and the glass is bounded
 * by the ground edge instead, which is a different question.
 */
function leastAxialGap(
  frontCurvature: number,
  frontZ: number,
  backCurvature: number,
  backZ: number,
  semiDiameter: number,
): number {
  let least = Infinity;
  for (let sample = 0; sample < PROFILE_SAMPLES; sample += 1) {
    const y = -semiDiameter + (2 * semiDiameter * sample) / (PROFILE_SAMPLES - 1);
    const gap = backZ + sag(backCurvature, y) - (frontZ + sag(frontCurvature, y));
    least = Math.min(least, gap);
  }
  return least;
}

/**
 * Builds everything the meridional layout draws: surface profiles, filled glass
 * bodies between them, and ray polylines. Surfaces with no aperture fall back to
 * `defaultSemiDiameter` so an unbounded surface still has something to draw.
 */
export function buildLayout(
  system: OpticalSystem,
  traces: readonly { result: RayTraceResult; wavelengthIndex: number }[],
  defaultSemiDiameter: number,
): LayoutGeometry {
  const profiles: SurfaceProfile[] = [];
  const heights: number[] = [];

  // Surface 0 is the object, which sits at −∞ for a distant object; never drawn.
  for (let index = 1; index < system.surfaces.length; index += 1) {
    const surface = system.surfaceAt(index);
    const vertexZ = system.vertexZAt(index);
    const semiDiameter = Number.isFinite(surface.semiDiameter)
      ? surface.semiDiameter
      : defaultSemiDiameter;
    heights.push(semiDiameter);

    const points: LayoutPoint[] = [];
    for (let sample = 0; sample < PROFILE_SAMPLES; sample += 1) {
      const y = -semiDiameter + (2 * semiDiameter * sample) / (PROFILE_SAMPLES - 1);
      points.push({ z: vertexZ + sag(surface.curvature, y), y });
    }
    profiles.push({
      surfaceIndex: index,
      points,
      isStop: surface.isStop,
      isImage: surface.type === 'IMAGE',
    });
  }

  // A glass body spans a surface whose following medium is not air.
  const bodies: GlassBody[] = [];
  for (let index = 1; index < system.surfaces.length - 1; index += 1) {
    const material = system.surfaceAt(index).material;
    if (Math.abs(material.indexAt(system.primaryWavelengthNm) - 1) < 1e-9) {
      continue;
    }
    const front = profiles.find((profile) => profile.surfaceIndex === index);
    const back = profiles.find((profile) => profile.surfaceIndex === index + 1);
    if (!front || !back) {
      continue;
    }

    // The profiles run −y to +y, so the first and last points are the two rims.
    const frontBottom = front.points[0]!;
    const frontTop = front.points[front.points.length - 1]!;
    const backBottom = back.points[0]!;
    const backTop = back.points[back.points.length - 1]!;

    // Two ways the element can fail, and both are the same measurement: the
    // surfaces crossing over the aperture they share, and — when the rear
    // surface is the smaller — the front surface reaching past its rim, which
    // turns the ground edge back on itself. With equal semi-diameters the
    // second is just the rim sample of the first, so nothing is double-counted.
    const leastGap = Math.min(
      leastAxialGap(
        system.surfaceAt(index).curvature,
        system.vertexZAt(index),
        system.surfaceAt(index + 1).curvature,
        system.vertexZAt(index + 1),
        Math.min(Math.abs(frontTop.y), Math.abs(backTop.y)),
      ),
      backTop.z - frontTop.z,
    );

    bodies.push({
      points: [...front.points, ...[...back.points].reverse()],
      frontIndex: index,
      backIndex: index + 1,
      topEdge: [frontTop, backTop],
      bottomEdge: [frontBottom, backBottom],
      leastGap,
      crossed: leastGap < 0,
    });
  }

  const rayPaths = traces.map(({ result, wavelengthIndex }) => {
    const points: LayoutPoint[] = [{ z: result.inputRay.origin.z, y: result.inputRay.origin.y }];
    for (const hit of result.intersections) {
      points.push({ z: hit.point.z, y: hit.point.y });
    }
    if (result.status === 'BLOCKED') {
      points.push({ z: result.finalRay.origin.z, y: result.finalRay.origin.y });
    }
    return { points, wavelengthIndex, blocked: result.status !== 'TERMINATED' };
  });

  const allPoints = [
    ...profiles.flatMap((profile) => profile.points),
    ...rayPaths.flatMap((path) => path.points),
  ];
  const fallbackHeight = Math.max(...heights, defaultSemiDiameter, 1);
  const bounds = allPoints.length
    ? {
        minZ: Math.min(...allPoints.map((point) => point.z)),
        maxZ: Math.max(...allPoints.map((point) => point.z)),
        minY: Math.min(...allPoints.map((point) => point.y)),
        maxY: Math.max(...allPoints.map((point) => point.y)),
      }
    : { minZ: 0, maxZ: 1, minY: -fallbackHeight, maxY: fallbackHeight };

  return { profiles, bodies, rayPaths, bounds };
}

/** Turns system-space points into an SVG path, using a caller-supplied mapping. */
export function toPath(
  points: readonly LayoutPoint[],
  project: (point: LayoutPoint) => { x: number; y: number },
  close = false,
): string {
  if (points.length === 0) {
    return '';
  }
  const commands = points.map((point, index) => {
    const { x, y } = project(point);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return commands.join(' ') + (close ? ' Z' : '');
}
