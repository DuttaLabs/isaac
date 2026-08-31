import { BufferGeometry, Float32BufferAttribute, LatheGeometry, Matrix4, Vector2 } from 'three';
import { aperturePatch, needsAperturePatch, obscurationGeometry } from './aperture-patch.ts';
import {
  signedMediaIndices,
  surfaceProfileSag,
  type OpticalSystem,
  type RayTraceResult,
  type Surface,
  type SurfaceShape,
  type Transform3,
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

/**
 * The part of a surface an obscuration blocks, drawn in its own right.
 *
 * Its own list rather than a flag on the surface it sits on, because it is drawn
 * differently in every way that matters: opaque where surfaces are translucent,
 * black where they take the element's color, and present only where a surface
 * carries an obscuring aperture.
 */
export interface ObscurationGeometry {
  surfaceIndex: number;
  geometry: BufferGeometry;
}

/** A surface drawn on its own: an image plane, a stop, a bare air surface. */
export interface SurfaceShellGeometry {
  surfaceIndex: number;
  /**
   * A lathe where the surface is one of revolution, and a triangulated patch
   * where it is not — a rectangular or elliptical aperture, or a circular one
   * cut off the surface's own axis. `BufferGeometry` because that is what both
   * are, and nothing downstream needs to know which it got.
   */
  geometry: BufferGeometry;
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
  /** Which field the bundle belongs to, for a view that colors by it. */
  fieldIndex: number;
  /** Never reached the image: drawn faint, as in the 2-D layout. */
  blocked: boolean;
  geometry: BufferGeometry;
  segmentCount: number;
}

export interface OpticalScene {
  elements: ElementGeometry[];
  surfaces: SurfaceShellGeometry[];
  /** The parts of surfaces that stop light: drawn opaque and black. */
  obscurations: ObscurationGeometry[];
  rays: RayBundleGeometry[];
  /** Axis-aligned extent of everything drawn, for framing a camera. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** Frees every geometry. Nothing else owns them. */
  dispose(): void;
}

export interface SceneTrace {
  result: RayTraceResult;
  wavelengthIndex: number;
  fieldIndex: number;
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
  innerRadius = 0,
): Vector2[] {
  const points: Vector2[] = [];
  const span = semiDiameter - innerRadius;
  for (let sample = 0; sample < samples; sample += 1) {
    const r = innerRadius + (span * sample) / (samples - 1);
    points.push(new Vector2(r, vertexZ + surfaceProfileSag(shape, r)));
  }
  return points;
}

/**
 * The radius of the hole down the middle of a surface, if it has one.
 *
 * Only a clear aperture with an inner radius leaves one: the light passes in the
 * ring, so there is no material in the middle to revolve. Starting the lathe out
 * there is the whole of what makes the Hubble's primary a mirror you can see
 * through rather than a disc — and because a lathe revolved from a non-zero
 * radius no longer closes on the axis, an element with a hole is not welded into
 * one solid, for the same reason a transform between two faces is not.
 */
function holeRadiusOf(surface: Surface): number {
  const aperture = surface.aperture;
  return aperture !== undefined && aperture.kind === 'CIRCULAR' ? aperture.minRadius : 0;
}

/**
 * How many rings across an aperture patch. The surface is smooth, so the shape
 * is carried by the *boundary* — which `segments` samples — rather than by the
 * radial direction; a handful of rings is enough to curve.
 */
const PATCH_RINGS = 8;

/**
 * Carries geometry into place, baking the pose into the vertices.
 *
 * Baked rather than hung on a node because the scene is built outside React and
 * handed over as plain geometry, with nothing to attach a transform to.
 */
function placed<T extends BufferGeometry>(geometry: T, pose: Transform3): T {
  geometry.applyMatrix4(toMatrix4(pose));
  return geometry;
}

function lathe(points: Vector2[], segments: number, pose?: Transform3): LatheGeometry {
  const geometry = new LatheGeometry(points, segments);
  // Lathe revolves about Y; the optical axis is Z.
  geometry.rotateX(Math.PI / 2);
  if (pose !== undefined) {
    // Everything is revolved about the surface's *own* axis and then carried
    // into place, so a coordinate transform tilts the element rather than shearing
    // it. Baked into the vertices because the scene is built outside React and
    // handed over as plain geometry, with no node to hang a transform on.
    geometry.applyMatrix4(toMatrix4(pose));
  }
  return geometry;
}

/** A core `Transform3` as the matrix Three wants. */
function toMatrix4(pose: Transform3): Matrix4 {
  const r = pose.rotation;
  return new Matrix4().set(
    r[0]!,
    r[1]!,
    r[2]!,
    pose.origin.x,
    r[3]!,
    r[4]!,
    r[5]!,
    pose.origin.y,
    r[6]!,
    r[7]!,
    r[8]!,
    pose.origin.z,
    0,
    0,
    0,
    1,
  );
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
    if (!isGlass(index) || system.surfaceAt(index).type === 'COORDINATE_TRANSFORM') {
      continue;
    }
    // A coordinate transform between the two faces would mean they no longer share
    // an axis, and a single revolved solid cannot express that. The two surfaces
    // are drawn separately instead of being welded into a shape neither has.
    if (system.surfaceAt(index + 1).type === 'COORDINATE_TRANSFORM') {
      continue;
    }
    // The same rule for the same reason: a face bounded by a rectangle, an
    // ellipse or an off-center circle is not a surface of revolution, so the
    // pair cannot be one lathe. Each face is drawn over its own aperture
    // instead, and the ground edge between them is left undrawn rather than
    // faked — an edge joining two boundaries of different shapes is a solid
    // this has no way to build yet.
    if (
      needsAperturePatch(system.surfaceAt(index)) ||
      needsAperturePatch(system.surfaceAt(index + 1))
    ) {
      continue;
    }
    const frontRadius = radiusOf(index);
    const backRadius = radiusOf(index + 1);
    const frontShape = system.surfaceAt(index).shape;
    const backShape = system.surfaceAt(index + 1).shape;
    // Built in the front surface's frame — the rear vertex is a distance along
    // its axis — and carried into place as one piece.
    const pose = system.poseAt(index);
    const backOffset = system.vertexZAt(index + 1) - system.vertexZAt(index);

    // A hole through the element is the widest of its two faces' holes: the
    // light passes through both, so the material that is missing is missing from
    // the whole run. It also stops the two ends landing on the axis, which is
    // what usually closes the revolution — so a holed element is a tube, open at
    // the bore, which is exactly the shape it is.
    const hole = Math.max(
      holeRadiusOf(system.surfaceAt(index)),
      holeRadiusOf(system.surfaceAt(index + 1)),
    );

    // Out along the front surface, across the ground edge, back along the rear.
    // Both ends land on the axis, which is what closes the revolution into a
    // solid rather than leaving two open caps.
    const profile = [
      ...surfaceProfile(frontShape, 0, frontRadius, samples, hole),
      ...surfaceProfile(backShape, backOffset, backRadius, samples, hole).reverse(),
    ];

    elements.push({
      frontIndex: index,
      backIndex: index + 1,
      geometry: lathe(profile, segments, pose),
      crossed: leastAxialGap(system, index, samples, travelAfter(index)) < 0,
    });
    consumed.add(index);
    consumed.add(index + 1);
  }

  const surfaces: SurfaceShellGeometry[] = [];
  const obscurations: ObscurationGeometry[] = [];
  // From 0, so a finite object plane is drawn like the image plane at the other
  // end. An object at infinity has no pose to build one on, and no plane either.
  for (let index = 0; index < system.surfaces.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    if (index === 0 && !Number.isFinite(system.vertexZAt(0))) {
      continue;
    }
    const surface = system.surfaceAt(index);
    // A coordinate transform has no shape and no aperture — nothing to revolve.
    if (surface.type === 'COORDINATE_TRANSFORM') {
      continue;
    }
    // What the surface's aperture *blocks*, where it blocks rather than bounds.
    const blocked = obscurationGeometry(
      surface,
      options.defaultSemiDiameter,
      PATCH_RINGS,
      segments,
    );

    // **A surface whose only job is to obscure is drawn as the obscuration and
    // nothing else.** The dummy plane carrying a Schmidt-Cassegrain's spider has
    // no glass, no coating and no rim — its semi-diameter is a number the
    // program computed, and drawing a disc there puts a pane in the beam that
    // does not exist. Once the shell is gone the vanes have nothing to be
    // coplanar with either, which is the z-fighting rather than a symptom of it.
    //
    // A surface that does something *besides* obscure keeps its shell: a mirror
    // with a spot painted on it is still a mirror.
    const obscuringOnly =
      blocked !== undefined && !surface.reflective && surface.type === 'STANDARD';
    if (!obscuringOnly) {
      surfaces.push({
        surfaceIndex: index,
        geometry: needsAperturePatch(surface)
          ? placed(
              aperturePatch(surface, options.defaultSemiDiameter, PATCH_RINGS, segments),
              system.poseAt(index),
            )
          : lathe(
              surfaceProfile(surface.shape, 0, radiusOf(index), samples, holeRadiusOf(surface)),
              segments,
              system.poseAt(index),
            ),
        isStop: surface.isStop,
        isImage: surface.type === 'IMAGE',
        isMirror: surface.reflective,
      });
    }

    if (blocked !== undefined) {
      obscurations.push({ surfaceIndex: index, geometry: placed(blocked, system.poseAt(index)) });
    }
  }

  const rays = buildRayBundles(traces);

  return {
    elements,
    surfaces,
    obscurations,
    rays,
    bounds: sceneBounds(system, traces, radiusOf),
    dispose(): void {
      for (const element of elements) {
        element.geometry.dispose();
      }
      for (const shell of surfaces) {
        shell.geometry.dispose();
      }
      for (const blocked of obscurations) {
        blocked.geometry.dispose();
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
  const groups = new Map<
    string,
    { wavelengthIndex: number; fieldIndex: number; blocked: boolean; values: number[] }
  >();

  // Grouped by field as well as wavelength, so a view that colors by field has
  // one buffer per color rather than one buffer holding several.
  for (const { result, wavelengthIndex, fieldIndex } of traces) {
    const blocked = result.status !== 'TERMINATED';
    const key = `${fieldIndex}:${wavelengthIndex}:${blocked}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { wavelengthIndex, fieldIndex, blocked, values: [] };
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
      fieldIndex: group.fieldIndex,
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
