/**
 * Where the 3-D camera has to stand to hold a system in frame.
 *
 * Kept out of the view, and free of Three, because it is arithmetic with a right
 * answer: the fit used to be computed against a **hard-coded canvas aspect**,
 * which was the shape of the 3-D panel back when the CSS pinned one. Panels are
 * freely resizable now, so that constant fitted every system to the shape of a
 * panel that no longer exists — a whole class of mistake that is invisible on
 * screen (the picture is always *a* picture) and obvious in a test.
 */

/** What a fit needs to know about the system: no geometry, just its extent. */
export interface SystemExtent {
  /** The point the camera looks at — the center of the system's bounding sphere. */
  readonly target: readonly [number, number, number];
  /** Half the extent across the frame: up the screen, seen from the side. */
  readonly halfHeight: number;
  /** Half the extent along the optical axis, which lies across the frame. */
  readonly halfLength: number;
  /** The bounding sphere's radius, which the depth range is scaled from. */
  readonly radius: number;
}

export interface CameraFit {
  /** Vertical field of view in degrees. Ignored when projecting orthographically. */
  readonly fieldOfView: number;
  readonly fitMargin: number;
  /**
   * A multiple of the fitted distance: 1 stands where the fit put the camera, 2
   * twice as far off. Orthographically it moves the camera without changing what
   * is seen, since size there is zoom rather than distance.
   */
  readonly cameraDistance: number;
  readonly projection: 'perspective' | 'orthographic';
}

export interface CameraPlacement {
  readonly position: [number, number, number];
  readonly near: number;
  readonly far: number;
  /** 1 for a perspective camera, which is sized by distance rather than by zoom. */
  readonly zoom: number;
}

/** A direction as a plain tuple; this file stays free of Three. */
type Vec3 = readonly [number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * The screen's own axes in world coordinates, for a camera standing along
 * `direction` from the target and looking back at it.
 *
 * Up is +Y, which is what `camera.up` is and what `OrbitControls` takes its
 * poles from. Looking very nearly straight down that axis leaves `right`
 * undefined, so the reference falls back to +Z — the same degeneracy the orbit
 * clamps away from, handled here because a fit may be asked for any direction.
 */
function viewAxes(direction: Vec3): { right: Vec3; up: Vec3 } {
  const forward: Vec3 = [-direction[0], -direction[1], -direction[2]];
  const reference: Vec3 = Math.abs(normalize(forward)[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, reference));
  return { right, up: normalize(cross(right, forward)) };
}

/**
 * How far the system reaches across the screen and up it, **from where the
 * camera actually stands**.
 *
 * The old rule read the two straight off the system: its diameter up the frame,
 * its length across it. That is exact for a side-on view and wrong for every
 * other one — and the home view looks down from about 25°, where a doublet's
 * 107 mm of length throws a vertical shadow more than twice the height of the
 * lens itself. So the vertical extent was under-counted by nearly a factor of
 * two.
 *
 * Nothing showed it while the *horizontal* term was the binding one, which it is
 * on any ordinary panel. Widen the panel enough — a second window's layout at
 * 1489 x 233, aspect 6.4 — and the horizontal term collapses, the under-counted
 * vertical term wins, and the camera stops too close: a centered model, clipped
 * top and bottom.
 *
 * This is the standard projection of an axis-aligned box onto an axis, each
 * half-extent contributing in proportion to how much of that axis it lies along.
 * The box is the system's own: `halfHeight` across both transverse axes, since a
 * lens is a figure of revolution, and `halfLength` along z.
 */
export function projectedHalfExtents(
  extent: SystemExtent,
  direction: Vec3,
): { horizontal: number; vertical: number } {
  const { right, up } = viewAxes(direction);
  const reach = (axis: Vec3): number =>
    extent.halfHeight * (Math.abs(axis[0]) + Math.abs(axis[1])) +
    extent.halfLength * Math.abs(axis[2]);
  return { horizontal: reach(right), vertical: reach(up) };
}

/**
 * How far a perspective camera must stand back.
 *
 * The two screen axes need different distances and the camera takes whichever is
 * further. Fitting the bounding sphere instead would pull back far enough for
 * the length in *both* directions and leave a long lens stranded in the middle
 * of an empty frame.
 */
export function fitDistance(
  extent: SystemExtent,
  fieldOfView: number,
  aspect: number,
  margin: number,
  direction: Vec3,
): number {
  const verticalTan = Math.tan((fieldOfView * Math.PI) / 360);
  const seen = projectedHalfExtents(extent, direction);
  return Math.max(seen.vertical / verticalTan, seen.horizontal / (verticalTan * aspect)) * margin;
}

/**
 * An orthographic camera's frame is measured in pixels — the one built here
 * spans the canvas — so fitting it is a matter of zoom rather than distance, and
 * the tighter of the two axes wins.
 */
export function fitZoom(
  extent: SystemExtent,
  width: number,
  height: number,
  margin: number,
  direction: Vec3,
): number {
  const seen = projectedHalfExtents(extent, direction);
  return Math.min(
    height / 2 / Math.max(seen.vertical * margin, 1e-9),
    width / 2 / Math.max(seen.horizontal * margin, 1e-9),
  );
}

/**
 * Where the camera sits, and the depth range that brackets the system from
 * there. `direction` is the unit vector from the target out to the camera.
 */
export function placeCamera(
  extent: SystemExtent,
  fit: CameraFit,
  direction: readonly [number, number, number],
  width: number,
  height: number,
): CameraPlacement {
  const orthographic = fit.projection === 'orthographic';
  // Orthographically the distance no longer sets the size, so it is chosen only
  // to clear the system and give the depth range something to bracket.
  const distance =
    (orthographic
      ? extent.radius * 6
      : fitDistance(extent, fit.fieldOfView, width / height, fit.fitMargin, direction)) *
    fit.cameraDistance;

  return {
    position: [
      extent.target[0] + direction[0] * distance,
      extent.target[1] + direction[1] * distance,
      extent.target[2] + direction[2] * distance,
    ],
    near: orthographic ? extent.radius * 0.01 : Math.max(extent.radius / 500, 1e-4),
    far: orthographic ? distance + extent.radius * 6 : distance + extent.radius * 20,
    zoom: orthographic ? fitZoom(extent, width, height, fit.fitMargin, direction) : 1,
  };
}
