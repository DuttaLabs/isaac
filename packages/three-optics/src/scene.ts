import { BufferGeometry, Float32BufferAttribute, LatheGeometry, Vector2 } from 'three';
import {
  signedMediaIndices,
  surfaceProfileSag,
  type OpticalSystem,
  type RayTraceResult,
  type SurfaceShape,
} from '@isaac/optical-core';

/**
 * Three.js geometry for an optical system.
 *
 * Everything here is rotationally symmetric, which is the one fact that makes a
 * 3-D layout cheap: a surface is its meridional profile turned about the axis,
 * so the same sag that draws the 2-D cross-section builds the solid. Nothing in
 * this file renders or knows about React — it produces geometry and hands it
 * over, which is what keeps the Three.js layer separable from the UI and the
 * engine separable from both.
 *
 * Coordinates match the engine's: the optical axis is +Z, rays run −Z → +Z.
 * `LatheGeometry` revolves about Y, so every geometry here is rotated a quarter
 * turn about X as it is built, and comes out already in the engine's frame.
 */

export interface SceneOptions {
  /** Semi-diameter for a surface with no aperture of its own. */
  defaultSemiDiameter: number;
  /** Segments around the axis. 64 is smooth at any size a layout is viewed at. */
  segments?: number;
  /** Samples from axis to rim along a surface profile. */
  profileSamples?: number;
}

/** A lens: the solid between two surfaces, revolved in one piece. */
export interface ElementGeometry {
  frontIndex: number;
  backIndex: number;
  geometry: LatheGeometry;
  /** The surfaces cross, so the solid is self-intersecting and cannot be made. */
  crossed: boolean;
}

/** A surface drawn on its own: an image plane, a stop, a bare air surface. */
export interface SurfaceShellGeometry {
  surfaceIndex: number;
  geometry: LatheGeometry;
  isStop: boolean;
  isImage: boolean;
  /** A mirror: shaded as metal, and opaque, because nothing goes through it. */
  isMirror: boolean;
}

/**
 * Every ray of one wavelength sharing one fate, merged into a single geometry.
 * Rays are drawn as segment pairs rather than polylines so a whole bundle is one
 * draw call — a pupil grid over three fields and three wavelengths is hundreds
 * of paths, and hundreds of objects would cost more than the geometry does.
 */
export interface RayBundleGeometry {
  wavelengthIndex: number;
  /** Never reached the image: drawn faint, as in the 2-D layout. */
  blocked: boolean;
  geometry: BufferGeometry;
  segmentCount: number;
}

export interface OpticalScene {
  elements: ElementGeometry[];
  surfaces: SurfaceShellGeometry[];
  rays: RayBundleGeometry[];
  /** Axis-aligned extent of everything drawn, for framing a camera. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** Frees every geometry. Nothing else owns them. */
  dispose(): void;
}

export interface SceneTrace {
  result: RayTraceResult;
  wavelengthIndex: number;
}

const DEFAULT_SEGMENTS = 64;
const DEFAULT_PROFILE_SAMPLES = 24;

/**
 * The half-profile of a surface, from the axis out to its rim, as
 * `LatheGeometry` wants it: x is radius, y is distance along the axis.
 *
 * The sag comes from the engine rather than from a copy kept here, so a conic
 * or an aspheric term shapes the solid exactly as it shapes the trace.
 */
export function surfaceProfile(
  shape: SurfaceShape,
  vertexZ: number,
  semiDiameter: number,
  samples = DEFAULT_PROFILE_SAMPLES,
): Vector2[] {
  const points: Vector2[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const r = (semiDiameter * sample) / (samples - 1);
    points.push(new Vector2(r, vertexZ + surfaceProfileSag(shape, r)));
  }
  return points;
}

function lathe(points: Vector2[], segments: number): LatheGeometry {
  const geometry = new LatheGeometry(points, segments);
  // Lathe revolves about Y; the optical axis is Z.
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

export function buildOpticalScene(
  system: OpticalSystem,
  traces: readonly SceneTrace[],
  options: SceneOptions,
): OpticalScene {
  const segments = options.segments ?? DEFAULT_SEGMENTS;
  const samples = options.profileSamples ?? DEFAULT_PROFILE_SAMPLES;

  const radiusOf = (index: number): number => {
    const semiDiameter = system.surfaceAt(index).semiDiameter;
    return Number.isFinite(semiDiameter) ? semiDiameter : options.defaultSemiDiameter;
  };
  const isGlass = (index: number): boolean =>
    Math.abs(system.surfaceAt(index).material.indexAt(system.primaryWavelengthNm) - 1) >= 1e-9;
  const media = signedMediaIndices(system, system.primaryWavelengthNm);
  const travelAfter = (index: number): number => Math.sign(media[index] ?? 1);

  const elements: ElementGeometry[] = [];
  const consumed = new Set<number>();

  // Surface 0 is the object, which may sit at −∞; never drawn.
  for (let index = 1; index < system.surfaces.length - 1; index += 1) {
    if (!isGlass(index)) {
      continue;
    }
    const frontRadius = radiusOf(index);
    const backRadius = radiusOf(index + 1);
    const frontShape = system.surfaceAt(index).shape;
    const backShape = system.surfaceAt(index + 1).shape;
    const frontZ = system.vertexZAt(index);
    const backZ = system.vertexZAt(index + 1);

    // Out along the front surface, across the ground edge, back along the rear.
    // Both ends land on the axis, which is what closes the revolution into a
    // solid rather than leaving two open caps.
    const profile = [
      ...surfaceProfile(frontShape, frontZ, frontRadius, samples),
      ...surfaceProfile(backShape, backZ, backRadius, samples).reverse(),
    ];

    elements.push({
      frontIndex: index,
      backIndex: index + 1,
      geometry: lathe(profile, segments),
      crossed: leastAxialGap(system, index, samples, travelAfter(index)) < 0,
    });
    consumed.add(index);
    consumed.add(index + 1);
  }

  const surfaces: SurfaceShellGeometry[] = [];
  for (let index = 1; index < system.surfaces.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const surface = system.surfaceAt(index);
    surfaces.push({
      surfaceIndex: index,
      geometry: lathe(
        surfaceProfile(surface.shape, system.vertexZAt(index), radiusOf(index), samples),
        segments,
      ),
      isStop: surface.isStop,
      isImage: surface.type === 'IMAGE',
      isMirror: surface.reflective,
    });
  }

  const rays = buildRayBundles(traces);

  return {
    elements,
    surfaces,
    rays,
    bounds: sceneBounds(system, traces, radiusOf),
    dispose(): void {
      for (const element of elements) {
        element.geometry.dispose();
      }
      for (const shell of surfaces) {
        shell.geometry.dispose();
      }
      for (const bundle of rays) {
        bundle.geometry.dispose();
      }
    },
  };
}

/**
 * Least distance between a surface and the next, along the light, over the
 * aperture they share. Negative means the rear surface has crossed in front of
 * the front one, so the revolved solid passes through itself — the same fault
 * the 2-D layout marks, measured the same way so the two views agree.
 *
 * `travel` is the direction the light is going between the two, taken from the
 * sign of the medium's index. After a mirror the next surface sits at smaller z
 * quite legitimately, and measuring along the axis instead of along the light
 * would call every reflecting element self-intersecting.
 */
function leastAxialGap(
  system: OpticalSystem,
  index: number,
  samples: number,
  travel: number,
): number {
  const front = system.surfaceAt(index);
  const back = system.surfaceAt(index + 1);
  const frontZ = system.vertexZAt(index);
  const backZ = system.vertexZAt(index + 1);
  const shared = Math.min(front.semiDiameter, back.semiDiameter);
  if (!Number.isFinite(shared)) {
    return travel * (backZ - frontZ);
  }

  const gapAt = (r: number): number =>
    travel *
    (backZ + surfaceProfileSag(back.shape, r) - (frontZ + surfaceProfileSag(front.shape, r)));

  let least = gapAt(shared);
  for (let sample = 0; sample < samples; sample += 1) {
    least = Math.min(least, gapAt((shared * sample) / (samples - 1)));
  }
  return least;
}

/** Groups rays by wavelength and fate, then merges each group into one buffer. */
function buildRayBundles(traces: readonly SceneTrace[]): RayBundleGeometry[] {
  const groups = new Map<string, { wavelengthIndex: number; blocked: boolean; values: number[] }>();

  for (const { result, wavelengthIndex } of traces) {
    const blocked = result.status !== 'TERMINATED';
    const key = `${wavelengthIndex}:${blocked}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { wavelengthIndex, blocked, values: [] };
      groups.set(key, group);
    }

    const points = rayPoints(result);
    for (let i = 0; i + 1 < points.length; i += 1) {
      const from = points[i]!;
      const to = points[i + 1]!;
      group.values.push(from[0], from[1], from[2], to[0], to[1], to[2]);
    }
  }

  return [...groups.values()].map((group) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(group.values, 3));
    return {
      wavelengthIndex: group.wavelengthIndex,
      blocked: group.blocked,
      geometry,
      segmentCount: group.values.length / 6,
    };
  });
}

/**
 * A ray's path in space. These are the engine's own 3-D intersection points —
 * the tracer has always worked in three dimensions, and the 2-D layout is the
 * projection, not the other way round.
 */
function rayPoints(result: RayTraceResult): [number, number, number][] {
  const origin = result.inputRay.origin;
  const points: [number, number, number][] = [[origin.x, origin.y, origin.z]];
  for (const hit of result.intersections) {
    points.push([hit.point.x, hit.point.y, hit.point.z]);
  }
  // A blocked ray stops at the aperture that stopped it, which is where the
  // final ray sits and is not among the recorded intersections.
  if (result.status === 'BLOCKED') {
    const end = result.finalRay.origin;
    points.push([end.x, end.y, end.z]);
  }
  return points;
}

function sceneBounds(
  system: OpticalSystem,
  traces: readonly SceneTrace[],
  radiusOf: (index: number) => number,
): { min: [number, number, number]; max: [number, number, number] } {
  let minZ = Infinity;
  let maxZ = -Infinity;
  let radius = 0;

  for (let index = 1; index < system.surfaces.length; index += 1) {
    const r = radiusOf(index);
    const vertexZ = system.vertexZAt(index);
    const sagAtRim = system.surfaceAt(index).sagAt(r);
    minZ = Math.min(minZ, vertexZ, vertexZ + sagAtRim);
    maxZ = Math.max(maxZ, vertexZ, vertexZ + sagAtRim);
    radius = Math.max(radius, r);
  }

  for (const { result } of traces) {
    for (const [x, y, z] of rayPoints(result)) {
      if (!Number.isFinite(z)) {
        continue;
      }
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      radius = Math.max(radius, Math.hypot(x, y));
    }
  }

  if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    minZ = 0;
    maxZ = 1;
  }
  const extent = Math.max(radius, 1e-6);
  return { min: [-extent, -extent, minZ], max: [extent, extent, maxZ] };
}
