import { Quaternion, Vector3 } from 'three';
import { AXES, type Axis, type ProjectedAxis } from './view-plane.ts';

/**
 * The world axes as a camera sees them — the 3-D view's half of the orientation
 * gizmo, which the 2-D view gets from its {@link ProjectedAxis} plane instead.
 *
 * Split out of the view so it can be tested without a renderer, and because the
 * mapping is the easy thing to get backwards: a camera in Three looks down its
 * own **−Z**, so a world direction rotated into camera coordinates has its
 * screen-right component in x, its screen-up component in y, and how much of it
 * comes *at* the viewer in z. Reverse that last sign and the gizmo draws a dot
 * where a cross belongs — a picture that is confidently, silently inside out.
 *
 * SVG's y grows downward, which is the one negation here.
 *
 * Taken at the center of the view, which is what an orientation gizmo describes.
 * A perspective camera turns the axes slightly toward the edges of the frame; no
 * such gizmo has ever shown that, and one that did would wobble as the user
 * panned.
 */
const WORLD_AXES: readonly (readonly [Axis, Vector3])[] = AXES.map((axis) => [
  axis,
  new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0),
]);

// Reused between calls: this runs once per animation frame while the camera is
// moving, and a gizmo has no business allocating in that loop.
const inverse = new Quaternion();
const scratch = new Vector3();

export function cameraAxes(orientation: Quaternion): ProjectedAxis[] {
  inverse.copy(orientation).invert();
  return WORLD_AXES.map(([axis, direction]) => {
    scratch.copy(direction).applyQuaternion(inverse);
    return { axis, x: scratch.x, y: -scratch.y, toward: scratch.z };
  });
}
