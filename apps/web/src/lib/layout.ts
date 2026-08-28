import {
  Point3,
  signedMediaIndices,
  surfaceProfileSag,
  type OpticalSystem,
  type RayTraceResult,
  type SurfaceShape,
} from '@isaac/optical-core';
import { projectToPlane, VIEW_PLANES, type LayoutPoint, type ViewPlane } from './view-plane.ts';

export type { LayoutPoint } from './view-plane.ts';

export interface SurfaceProfile {
  surfaceIndex: number;
  points: LayoutPoint[];
  isStop: boolean;
  isImage: boolean;
  /** A mirror: drawn as metal rather than as one more glass surface. */
  isMirror: boolean;
  /**
   * A closed outline rather than an open curve — the rim, drawn end-on, where a
   * surface has no cross-section. It has no two ends, so nothing that reads
   * `points[0]` and `points[n - 1]` as the two rims applies to it.
   */
  closed: boolean;
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
  /** The plane this geometry was projected into; it is not readable without it. */
  view: ViewPlane;
  profiles: SurfaceProfile[];
  bodies: GlassBody[];
  rayPaths: {
    points: LayoutPoint[];
    wavelengthIndex: number;
    /** Which field the ray belongs to; the layout colors by it. */
    fieldIndex: number;
    blocked: boolean;
  }[];
  bounds: { minH: number; maxH: number; minV: number; maxV: number };
}

const PROFILE_SAMPLES = 33;
/** Points around a rim drawn end-on. Enough that a circle reads as one. */
const RIM_SAMPLES = 64;

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
 *
 * The answer is a fact about the element and not about the view, so it is the
 * same number in every plane — an element that cannot be made does not become
 * makeable by turning it a quarter turn.
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
 * The surface's outline in its own frame, before the pose carries it into place.
 *
 * In a plane containing the axis this is the cross-section a lens designer
 * reads: the sag swept along whichever transverse axis is drawn upright, which
 * is y in the meridional view and x in the sagittal one. The two are the same
 * curve on a rotationally symmetric surface, and they are drawn from the same
 * sag for exactly that reason — the difference between the views is where the
 * *system* has put the surface, not what the surface is.
 *
 * End-on there is no section to draw. What bounds a surface seen down the axis
 * is its rim, so that is the circle traced — at the rim's own sag, so a tilted
 * surface's rim projects to the ellipse it really is rather than to a circle.
 */
function outlineInLocalFrame(shape: SurfaceShape, semiDiameter: number, view: ViewPlane): Point3[] {
  if (!view.axial) {
    const rimSag = sag(shape, semiDiameter);
    return Array.from({ length: RIM_SAMPLES + 1 }, (_, sample) => {
      const angle = (2 * Math.PI * sample) / RIM_SAMPLES;
      return new Point3(semiDiameter * Math.cos(angle), semiDiameter * Math.sin(angle), rimSag);
    });
  }

  const upright = view.vertical;
  return Array.from({ length: PROFILE_SAMPLES }, (_, sample) => {
    const height = -semiDiameter + (2 * semiDiameter * sample) / (PROFILE_SAMPLES - 1);
    const depth = sag(shape, height);
    return upright === 'y' ? new Point3(0, height, depth) : new Point3(height, 0, depth);
  });
}

/**
 * Builds everything a 2-D layout draws in one plane: surface outlines, filled
 * glass bodies between them, and ray polylines. Surfaces with no aperture fall
 * back to `defaultSemiDiameter` so an unbounded surface still has something to
 * draw.
 *
 * The plane defaults to the meridional one, which is the view a lens layout has
 * always meant.
 */
export function buildLayout(
  system: OpticalSystem,
  traces: readonly { result: RayTraceResult; wavelengthIndex: number; fieldIndex: number }[],
  defaultSemiDiameter: number,
  view: ViewPlane = VIEW_PLANES.YZ,
): LayoutGeometry {
  const profiles: SurfaceProfile[] = [];
  const heights: number[] = [];
  // The sign of each medium's index is the direction the light is going in it,
  // which is what tells a lens from a reflecting arm laid out backwards.
  const media = signedMediaIndices(system, system.primaryWavelengthNm);
  const travelAfter = (index: number): number => Math.sign(media[index] ?? 1);

  // Surface 0 is the object, and it is drawn only when it is somewhere: at
  // infinity it has no pose and no plane to draw, while at a finite conjugate it
  // is as much a part of the layout as the image plane at the other end — and
  // the rays already start there, so the plane they leave was the one thing
  // missing from the picture.
  for (let index = 0; index < system.surfaces.length; index += 1) {
    if (index === 0 && !Number.isFinite(system.vertexZAt(0))) {
      continue;
    }
    const surface = system.surfaceAt(index);
    // A coordinate transform has no shape and no aperture: there is nothing to draw,
    // and drawing it would put a full-height plane across the fold. Its effect
    // is already in where the following surfaces sit.
    if (surface.type === 'COORDINATE_TRANSFORM') {
      continue;
    }
    const pose = system.poseAt(index);
    const semiDiameter = Number.isFinite(surface.semiDiameter)
      ? surface.semiDiameter
      : defaultSemiDiameter;
    heights.push(semiDiameter);

    // The outline is built in the surface's own frame and then carried into
    // global coordinates, so a tilted element is drawn tilted. For a centered
    // system this is the vertex offset it always was.
    const points = outlineInLocalFrame(surface.shape, semiDiameter, view).map((local) =>
      projectToPlane(pose.apply(local), view),
    );
    profiles.push({
      surfaceIndex: index,
      points,
      isStop: surface.isStop,
      isImage: surface.type === 'IMAGE',
      isMirror: surface.reflective,
      closed: !view.axial,
    });
  }

  // A glass body spans a surface whose following medium is not air. Only in a
  // plane containing the axis: end-on, an element is two rims one behind the
  // other and the glass between them is edge-on to the viewer, so there is no
  // section to fill and filling the rim would claim the whole aperture is solid.
  const bodies: GlassBody[] = [];
  for (let index = 1; view.axial && index < system.surfaces.length - 1; index += 1) {
    const surface = system.surfaceAt(index);
    if (surface.type === 'COORDINATE_TRANSFORM') {
      continue;
    }
    const material = surface.material;
    if (Math.abs(material.indexAt(system.primaryWavelengthNm) - 1) < 1e-9) {
      continue;
    }
    const front = profiles.find((profile) => profile.surfaceIndex === index);
    // The rear surface is the next one that is actually drawn: a transform between
    // the two faces of an element contributes no profile to close the body on.
    const back = profiles.find((profile) => profile.surfaceIndex > index);
    if (!front || !back) {
      continue;
    }

    // The outlines run −height to +height, so the first and last points are the
    // two rims.
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
        system.surfaceAt(back.surfaceIndex).shape,
        system.vertexZAt(back.surfaceIndex),
        Math.min(Math.abs(frontTop.v), Math.abs(backTop.v)),
        travel,
      ),
      travel * (backTop.h - frontTop.h),
    );

    bodies.push({
      points: [...front.points, ...[...back.points].reverse()],
      frontIndex: index,
      backIndex: back.surfaceIndex,
      topEdge: [frontTop, backTop],
      bottomEdge: [frontBottom, backBottom],
      leastGap,
      crossed: leastGap < 0,
    });
  }

  const rayPaths = traces.map(({ result, wavelengthIndex, fieldIndex }) => ({
    points: rayPath(result, view),
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
        minH: Math.min(...allPoints.map((point) => point.h)),
        maxH: Math.max(...allPoints.map((point) => point.h)),
        minV: Math.min(...allPoints.map((point) => point.v)),
        maxV: Math.max(...allPoints.map((point) => point.v)),
      }
    : { minH: 0, maxH: 1, minV: -fallbackHeight, maxV: fallbackHeight };

  return { view, profiles, bodies, rayPaths, bounds };
}

/**
 * The polyline a traced ray draws: its launch point, every surface it met, and —
 * when it was stopped by an aperture — the point it died at, which the
 * intersection list does not contain.
 *
 * Shared with the first-order overlay so an annotation ray is drawn by exactly
 * the same rule as the bundle it is drawn over.
 */
export function rayPath(result: RayTraceResult, view: ViewPlane = VIEW_PLANES.YZ): LayoutPoint[] {
  const points: LayoutPoint[] = [projectToPlane(result.inputRay.origin, view)];
  for (const hit of result.intersections) {
    points.push(projectToPlane(hit.point, view));
  }
  if (result.status === 'BLOCKED') {
    points.push(projectToPlane(result.finalRay.origin, view));
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
  view: ViewPlane = VIEW_PLANES.YZ,
): { contact: LayoutPoint; atPupil: LayoutPoint; produced: boolean } | undefined {
  const hit = result.intersections[0]?.point;
  const direction = result.inputRay.direction;
  if (hit === undefined || direction.z === 0) {
    return undefined;
  }
  const distance = (pupilZ - hit.z) / direction.z;
  return {
    contact: projectToPlane(hit, view),
    atPupil: projectToPlane(
      { x: hit.x + distance * direction.x, y: hit.y + distance * direction.y, z: pupilZ },
      view,
    ),
    // False when the pupil lies in front of the glass: the traced ray already
    // passes through it, so there is nothing to produce and a dashed line would
    // only be laid over the solid one.
    produced: distance > 0,
  };
}

/** Turns view-plane points into an SVG path, using a caller-supplied mapping. */
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
