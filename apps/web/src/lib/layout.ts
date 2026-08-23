import {
  signedMediaIndices,
  surfaceProfileSag,
  type OpticalSystem,
  type RayTraceResult,
  type SurfaceShape,
} from '@isaac/optical-core';

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
  /** A mirror: drawn as metal rather than as one more glass surface. */
  isMirror: boolean;
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
  rayPaths: {
    points: LayoutPoint[];
    wavelengthIndex: number;
    /** Which field the ray belongs to; the layout colors by it. */
    fieldIndex: number;
    blocked: boolean;
  }[];
  bounds: { minZ: number; maxZ: number; minY: number; maxY: number };
}

const PROFILE_SAMPLES = 33;

/**
 * Axial sag at transverse height `y`, from the engine's own definition of the
 * surface — conic and aspheric terms included. Re-exported so the layout's
 * callers do not reach past it into the core for the same number, and so the
 * drawn cross-section can never disagree with the traced shape.
 */
export function sag(shape: SurfaceShape, y: number): number {
  return surfaceProfileSag(shape, y);
}

/**
 * Least axial distance between two consecutive surfaces, over the aperture they
 * share. Negative means the rear surface has crossed in front of the front one:
 * the element would have to be thinner than nothing somewhere, which is a real
 * design fault, not a drawing artifact. It is the usual failure of a strongly
 * curved element whose semi-diameter has been opened up past what its center
 * thickness can support, and it shows up first at the edge of the aperture.
 *
 * Sampled rather than solved: the extremum of the gap is at the axis or the rim
 * for the shapes met in practice, but not in general, and sampling on the same
 * grid the profiles are drawn on keeps the verdict consistent with the picture.
 *
 * The shared aperture is `min` of the two semi-diameters — where both surfaces
 * actually exist. Past that only one surface is present and the glass is bounded
 * by the ground edge instead, which is a different question.
 *
 * `travel` is +1 while the light runs toward +Z and −1 after a mirror has turned
 * it round. The gap has to be measured along the light, not along the axis:
 * behind a mirror the next surface is at *smaller* z by design, and reading that
 * as negative thickness would condemn every reflecting system as impossible.
 */
function leastAxialGap(
  frontShape: SurfaceShape,
  frontZ: number,
  backShape: SurfaceShape,
  backZ: number,
  semiDiameter: number,
  travel: number,
): number {
  let least = Infinity;
  for (let sample = 0; sample < PROFILE_SAMPLES; sample += 1) {
    const y = -semiDiameter + (2 * semiDiameter * sample) / (PROFILE_SAMPLES - 1);
    const gap = travel * (backZ + sag(backShape, y) - (frontZ + sag(frontShape, y)));
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
  traces: readonly { result: RayTraceResult; wavelengthIndex: number; fieldIndex: number }[],
  defaultSemiDiameter: number,
): LayoutGeometry {
  const profiles: SurfaceProfile[] = [];
  const heights: number[] = [];
  // The sign of each medium's index is the direction the light is going in it,
  // which is what tells a lens from a reflecting arm laid out backwards.
  const media = signedMediaIndices(system, system.primaryWavelengthNm);
  const travelAfter = (index: number): number => Math.sign(media[index] ?? 1);

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
      points.push({ z: vertexZ + sag(surface.shape, y), y });
    }
    profiles.push({
      surfaceIndex: index,
      points,
      isStop: surface.isStop,
      isImage: surface.type === 'IMAGE',
      isMirror: surface.reflective,
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
    const travel = travelAfter(index);
    const leastGap = Math.min(
      leastAxialGap(
        system.surfaceAt(index).shape,
        system.vertexZAt(index),
        system.surfaceAt(index + 1).shape,
        system.vertexZAt(index + 1),
        Math.min(Math.abs(frontTop.y), Math.abs(backTop.y)),
        travel,
      ),
      travel * (backTop.z - frontTop.z),
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

  const rayPaths = traces.map(({ result, wavelengthIndex, fieldIndex }) => ({
    points: rayPath(result),
    wavelengthIndex,
    fieldIndex,
    blocked: result.status !== 'TERMINATED',
  }));

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

/**
 * The polyline a traced ray draws: its launch point, every surface it met, and —
 * when it was stopped by an aperture — the point it died at, which the
 * intersection list does not contain.
 *
 * Shared with the first-order overlay so an annotation ray is drawn by exactly
 * the same rule as the bundle it is drawn over.
 */
export function rayPath(result: RayTraceResult): LayoutPoint[] {
  const points: LayoutPoint[] = [{ z: result.inputRay.origin.z, y: result.inputRay.origin.y }];
  for (const hit of result.intersections) {
    points.push({ z: hit.point.z, y: hit.point.y });
  }
  if (result.status === 'BLOCKED') {
    points.push({ z: result.finalRay.origin.z, y: result.finalRay.origin.y });
  }
  return points;
}

/**
 * Where the marginal ray would have gone had the first surface not bent it: the
 * segment from its first contact with the glass, continued undeviated, to the
 * entrance pupil plane.
 *
 * This is the construction that says what an entrance pupil *is*. The pupil is
 * usually a virtual image of the stop, lying inside the glass or behind it, so
 * no real ray ever passes through it — the ray refracts long before. What
 * defines it is the incoming ray produced straight on: it meets the pupil plane
 * at the pupil rim, and that is the aperture object space actually sees, which
 * is what fixes the cone of angles the system will accept.
 *
 * Returns `undefined` for a ray that never reached a surface, or one running
 * parallel to the pupil plane, neither of which has a crossing to draw.
 */
export function pupilAim(
  result: RayTraceResult,
  pupilZ: number,
): { contact: LayoutPoint; atPupil: LayoutPoint; produced: boolean } | undefined {
  const hit = result.intersections[0]?.point;
  const direction = result.inputRay.direction;
  if (hit === undefined || direction.z === 0) {
    return undefined;
  }
  const distance = (pupilZ - hit.z) / direction.z;
  return {
    contact: { z: hit.z, y: hit.y },
    atPupil: { z: pupilZ, y: hit.y + distance * direction.y },
    // False when the pupil lies in front of the glass: the traced ray already
    // passes through it, so there is nothing to produce and a dashed line would
    // only be laid over the solid one.
    produced: distance > 0,
  };
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
