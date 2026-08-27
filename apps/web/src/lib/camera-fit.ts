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

/**
 * How far a perspective camera must stand back.
 *
 * Seen from the side, a system's length lies across the frame and its diameter
 * up it, so the two axes need different distances and the camera takes whichever
 * is further. Fitting the bounding sphere instead would pull back far enough for
 * the length in *both* directions and leave a long lens stranded in the middle
 * of an empty frame.
 */
export function fitDistance(
  extent: SystemExtent,
  fieldOfView: number,
  aspect: number,
  margin: number,
): number {
  const verticalTan = Math.tan((fieldOfView * Math.PI) / 360);
  return (
    Math.max(extent.halfHeight / verticalTan, extent.halfLength / (verticalTan * aspect)) * margin
  );
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
): number {
  return Math.min(
    height / 2 / Math.max(extent.halfHeight * margin, 1e-9),
    width / 2 / Math.max(extent.halfLength * margin, 1e-9),
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
      : fitDistance(extent, fit.fieldOfView, width / height, fit.fitMargin)) * fit.cameraDistance;

  return {
    position: [
      extent.target[0] + direction[0] * distance,
      extent.target[1] + direction[1] * distance,
      extent.target[2] + direction[2] * distance,
    ],
    near: orthographic ? extent.radius * 0.01 : Math.max(extent.radius / 500, 1e-4),
    far: orthographic ? distance + extent.radius * 6 : distance + extent.radius * 20,
    zoom: orthographic ? fitZoom(extent, width, height, fit.fitMargin) : 1,
  };
}
