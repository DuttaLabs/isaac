import {
  Point3,
  apertureHalfExtents,
  isObscuration,
  signedMediaIndices,
  surfaceProfileSag,
  type OpticalSystem,
  type RayTraceResult,
  type Surface,
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
  /**
   * The hole down the middle, when the surface's aperture has one — the Hubble's
   * primary, where the light comes back through the mirror it just bounced off.
   *
   * Indices into {@link points} rather than a radius, so the view draws the
   * outline as two runs of the samples it already has and nothing has to be
   * re-derived at draw time. `undefined` where there is no hole, which is every
   * surface in most designs.
   *
   * End-on there is no gap to leave: the hole is a second circle, and this is
   * the index the inner rim's samples begin at.
   */
  hole?: { from: number; to: number };
  /**
   * The run of the outline an obscuration covers — something *in the way* of the
   * surface rather than a piece missing from it, so the samples are stroked
   * over rather than skipped.
   *
   * Without this an obscuration smaller than the surface it sits on is drawn
   * nowhere at all: seven of the twenty-two in the sample corpus are, including
   * both Newtonians' diagonals and the Schmidt's. The trace stops those rays and
   * the picture showed nothing stopping them, which is the fault of drawing an
   * aperture the trace does not have, read backwards.
   */
  obscured?: { from: number; to: number }[];
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
function outlineInLocalFrame(
  shape: SurfaceShape,
  disc: Disc,
  view: ViewPlane,
  hole: Hole | undefined,
  /** True when the surface's aperture stops light where it is, rather than bounding it. */
  obscuring: boolean,
  /** The surface's own blocking rule — the one the tracer asks. */
  blocks: (x: number, y: number) => boolean,
): {
  points: Point3[];
  hole?: { from: number; to: number };
  obscured?: { from: number; to: number }[];
} {
  if (!view.axial) {
    // End-on, a hole is a second rim rather than a gap in the first: the inner
    // circle is appended to the outer one, and the index it starts at is what
    // tells the view where to break the path.
    const outer = rimSamples(shape, disc);
    if (hole === undefined) {
      return { points: outer };
    }
    const inner = rimSamples(shape, {
      radiusX: hole.radius,
      radiusY: hole.radius,
      centerX: hole.centerX,
      centerY: hole.centerY,
    });
    return { points: [...outer, ...inner], hole: { from: outer.length, to: outer.length } };
  }

  const upright = view.vertical;
  // The section runs across the piece that exists, which is not always centered
  // on the surface's own axis and not always as wide one way as the other.
  const middle = upright === 'y' ? disc.centerY : disc.centerX;
  const reach = upright === 'y' ? disc.radiusY : disc.radiusX;
  const center = upright === 'y' ? (hole?.centerY ?? 0) : (hole?.centerX ?? 0);
  const at = (sample: number): number =>
    middle - reach + (2 * reach * sample) / (PROFILE_SAMPLES - 1);
  // **The section is cut through the middle of the piece that exists**, which for
  // a decentered aperture is not through the surface's axis. Cutting at zero on
  // the other transverse axis draws a slice of the *parent* surface: on Zemax's
  // Unobscured Gregorian, whose mirror is a 55 mm circle taken 100 mm off the
  // parent's axis, the X–Z view drew a shallow curve near the parent's vertex
  // while the rays met the piece far down the paraboloid — a mirror the light
  // visibly missed.
  const across = upright === 'y' ? disc.centerX : disc.centerY;
  const points = Array.from({ length: PROFILE_SAMPLES }, (_, sample) => {
    const height = at(sample);
    // Sag is measured from the *surface's* axis, never from the aperture's
    // center: an off-axis parabola is a piece of the parent, and it curves the
    // way the parent does at that distance out. Which is why this is the radial
    // distance of the sampled point, not just its height in the view.
    const depth = sag(shape, Math.hypot(height, across));
    return upright === 'y' ? new Point3(across, height, depth) : new Point3(height, across, depth);
  });
  // The samples inside a hole are the ones the material is missing at, and the
  // ones inside an obscuration are where something is standing in the way. Both
  // are left in `points` — the bounds, the body and the stop bars all read them
  // — and only the *ink* changes: a hole is skipped, an obscuration drawn over.
  const covered = obscuring ? blockedRuns(points, blocks) : [];
  if (hole === undefined) {
    return covered.length === 0 ? { points } : { points, obscured: covered };
  }
  const span = coveredSamples(at, center, hole.radius);
  return {
    points,
    ...(span === undefined ? {} : { hole: span }),
    ...(covered.length === 0 ? {} : { obscured: covered }),
  };
}

/**
 * The runs of samples the surface actually stops light at, asked of the surface
 * itself.
 *
 * **Runs, plural, and asked rather than derived.** A spider crosses a section
 * more than once — a three-armed one lies across the meridional plane in two
 * places — so a single span cannot describe it. And asking `blocksAt`, which is
 * the same function the tracer calls, is what makes the promise hold in the
 * hard direction too: the picture cannot show an obscuration the trace does not
 * have, or miss one it does.
 */
function blockedRuns(
  points: readonly Point3[],
  blocks: (x: number, y: number) => boolean,
): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let open = -1;
  for (const [index, point] of points.entries()) {
    if (blocks(point.x, point.y)) {
      if (open === -1) {
        open = index;
      }
    } else if (open !== -1) {
      runs.push({ from: open, to: index - 1 });
      open = -1;
    }
  }
  if (open !== -1) {
    runs.push({ from: open, to: points.length - 1 });
  }
  return runs;
}

/**
 * Which samples fall within `radius` of `center` along the sampled axis, as a
 * first and last index — the form both a hole and an obscuration want, one being
 * the run to leave out and the other the run to draw over.
 */
function coveredSamples(
  at: (sample: number) => number,
  center: number,
  radius: number,
): { from: number; to: number } | undefined {
  let from = -1;
  let to = -1;
  for (let sample = 0; sample < PROFILE_SAMPLES; sample += 1) {
    if (Math.abs(at(sample) - center) < radius) {
      if (from === -1) {
        from = sample;
      }
      to = sample;
    }
  }
  return from === -1 ? undefined : { from, to };
}

/**
 * The piece of a surface that exists, in the surface's own frame: how far it
 * reaches along each axis, and how far off the axis it sits.
 *
 * Two radii rather than one because an aperture need not be round — a
 * rectangular or elliptical one reaches a different distance along x than along
 * y, and a Newtonian's diagonal is an ellipse whose major axis is √2 times its
 * minor for exactly that reason.
 */
interface Disc {
  radiusX: number;
  radiusY: number;
  centerX: number;
  centerY: number;
  /** Drawn with corners rather than as an ellipse. Only matters end-on. */
  rectangular?: boolean;
}

/** A hole in a surface: round, since only a circular aperture has an inner radius. */
interface Hole {
  radius: number;
  centerX: number;
  centerY: number;
}

/**
 * The piece of surface that actually exists, as a disc in the surface's frame.
 *
 * **The aperture wins when there is one, because the aperture *is* the part.**
 * An off-axis parabola is written as a parent parabola plus a clear aperture
 * cut some way off its axis — Zemax's own `Unobscured Gregorian` is a 55 mm
 * circle taken 100 mm off a parent whose vertex is nowhere near the beam — and
 * drawing the parent disc instead would draw a mirror nobody has, straddling the
 * axis it was designed to keep clear. Those files set the semi-diameter to zero
 * to say exactly that: there is no parent disc to draw.
 *
 * An obscuration does not bound the surface — it is something sitting in the way
 * of one — so it falls through to the drawn extent like a surface with no
 * aperture at all.
 */
function drawnDisc(surface: Surface, fallback: number): Disc {
  const extent = Number.isFinite(surface.semiDiameter) ? surface.semiDiameter : fallback;
  const aperture = surface.aperture;
  // `apertureHalfExtents` answers `undefined` for anything that does not bound
  // the surface — an obscuration, or no aperture — which is where the drawn
  // extent takes over.
  const half = apertureHalfExtents(aperture, extent);
  if (aperture === undefined || half === undefined) {
    return { radiusX: extent, radiusY: extent, centerX: 0, centerY: 0 };
  }
  return {
    radiusX: Number.isFinite(half.x) ? half.x : extent,
    radiusY: Number.isFinite(half.y) ? half.y : extent,
    centerX: aperture.decenterX,
    centerY: aperture.decenterY,
    // A rectangle drawn end-on is a rectangle. Every other kind here is round,
    // and the section through any of them is the same either way.
    rectangular: aperture.kind === 'RECTANGULAR' || aperture.kind === 'RECTANGULAR_OBSCURATION',
  };
}

/**
 * The hole an aperture leaves in the material, if it leaves one.
 *
 * Only a clear aperture with an inner radius does: light passes in the ring, so
 * the middle is not there to be drawn. An obscuration is the opposite — the
 * middle is *all* there is — and the surface is already drawn at the extent that
 * describes it.
 */
function holeIn(surface: Surface): Hole | undefined {
  const aperture = surface.aperture;
  return aperture !== undefined && aperture.kind === 'CIRCULAR' && aperture.minRadius > 0
    ? { radius: aperture.minRadius, centerX: aperture.decenterX, centerY: aperture.decenterY }
    : undefined;
}

/**
 * The rim of a piece of surface, seen end-on.
 *
 * The sag is taken **per sample**, from each point's own distance to the
 * surface's axis, rather than once for the whole rim. On a circle centered on
 * the axis those are the same number, which is what the earlier version relied
 * on; on a decentered, rectangular or elliptical rim they are not, and a single
 * sag would draw a flat outline where the real rim rises and falls around the
 * curve it is cut from.
 */
function rimSamples(shape: SurfaceShape, disc: Disc): Point3[] {
  return Array.from({ length: RIM_SAMPLES + 1 }, (_, sample) => {
    const fraction = sample / RIM_SAMPLES;
    const { x, y } =
      disc.rectangular === true
        ? rectanglePoint(disc, fraction)
        : {
            x: disc.centerX + disc.radiusX * Math.cos(2 * Math.PI * fraction),
            y: disc.centerY + disc.radiusY * Math.sin(2 * Math.PI * fraction),
          };
    return new Point3(x, y, sag(shape, Math.hypot(x, y)));
  });
}

/** A point `fraction` of the way round a rectangle, corners included. */
function rectanglePoint(disc: Disc, fraction: number): { x: number; y: number } {
  const side = Math.min(Math.floor(fraction * 4), 3);
  const along = fraction * 4 - side;
  const x = disc.radiusX;
  const y = disc.radiusY;
  const corners = [
    [x, -y],
    [x, y],
    [-x, y],
    [-x, -y],
  ];
  const from = corners[side]!;
  const to = corners[(side + 1) % 4]!;
  return {
    x: disc.centerX + from[0]! + (to[0]! - from[0]!) * along,
    y: disc.centerY + from[1]! + (to[1]! - from[1]!) * along,
  };
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
    const disc = drawnDisc(surface, defaultSemiDiameter);
    // The bound is how far the drawing reaches, which for a decentered piece is
    // its far edge rather than its radius.
    heights.push(Math.abs(disc.centerY) + disc.radiusY, Math.abs(disc.centerX) + disc.radiusX);

    // The outline is built in the surface's own frame and then carried into
    // global coordinates, so a tilted element is drawn tilted. For a centered
    // system this is the vertex offset it always was.
    const aperture = surface.aperture;
    const outline = outlineInLocalFrame(
      surface.shape,
      disc,
      view,
      holeIn(surface),
      aperture !== undefined && isObscuration(aperture.kind),
      (x, y) => surface.blocksAt(x, y),
    );
    const points = outline.points.map((local) => projectToPlane(pose.apply(local), view));
    profiles.push({
      surfaceIndex: index,
      points,
      isStop: surface.isStop,
      isImage: surface.type === 'IMAGE',
      isMirror: surface.reflective,
      closed: !view.axial,
      ...(outline.hole === undefined ? {} : { hole: outline.hole }),
      ...(outline.obscured === undefined ? {} : { obscured: outline.obscured }),
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
