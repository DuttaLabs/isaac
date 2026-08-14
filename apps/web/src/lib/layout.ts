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
    if (front && back) {
      bodies.push({ points: [...front.points, ...[...back.points].reverse()] });
    }
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
