/**
 * The plane a 2-D layout is drawn in.
 *
 * A cross-section has to say which one it is, because three of them are worth
 * looking at and they answer different questions. The two containing the axis
 * are the designer's usual pair — meridional and sagittal — and differ only in
 * which transverse axis is drawn upright; the third looks straight down the axis
 * and shows the beam's footprint, which is where a decenter or a tilt about the
 * axis actually shows itself.
 *
 * Everything about a view follows from its two screen axes, so that is all a
 * `ViewPlane` states. The third axis is *derived*: a right-handed screen frame
 * has right × up pointing out of the screen, which fixes both which axis it is
 * and whether it runs toward the viewer or away. Writing it down by hand would
 * be a second, contradictable source for the same fact — and getting it wrong
 * would draw an orientation gizmo that is confidently mirror-imaged.
 */

/** A point in the view plane: `h` runs right on screen, `v` runs up. */
export interface LayoutPoint {
  h: number;
  v: number;
}

/** Anything with world coordinates: `Point3`, `Vector3`, a plain triple. */
export interface Positioned {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type Axis = 'x' | 'y' | 'z';

export type ViewPlaneId = 'YZ' | 'XZ' | 'XY';

/** Which way the third axis goes, and which axis it is. */
export interface OutOfPlaneAxis {
  readonly axis: Axis;
  /** +1 out of the screen toward the viewer, −1 into it. */
  readonly sign: 1 | -1;
}

export interface ViewPlane {
  readonly id: ViewPlaneId;
  /** What the dropdown shows. */
  readonly label: string;
  /** The world axis running right on screen. */
  readonly horizontal: Axis;
  /** The world axis running up on screen. */
  readonly vertical: Axis;
  /** The remaining axis, derived from the other two. */
  readonly outward: OutOfPlaneAxis;
  /** One sentence, for the dropdown's tooltip and the gizmo's. */
  readonly description: string;
  /**
   * Which pupil axis a ray fan has to be spread along for its rays to lie in
   * this plane — `undefined` end-on, where no fan does, and the pupil grid the
   * 3-D view already traces is what fills the picture instead.
   */
  readonly fanAxis: 'x' | 'y' | undefined;
  /**
   * Whether the optical axis lies in the plane. True of the two cross-sections,
   * where an element has a profile and the glass between two surfaces can be
   * filled in; false end-on, where a surface is bounded by its rim and there is
   * no section to fill.
   */
  readonly axial: boolean;
}

const UNIT: Record<Axis, readonly [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

const AXIS_ORDER: readonly Axis[] = ['x', 'y', 'z'];

/**
 * right × up: the axis out of the screen, toward the viewer.
 *
 * The two screen axes are unit vectors along coordinate axes, so their cross
 * product is ±1 on exactly one axis — no normalization and no near-zero case to
 * worry about. It throws on a degenerate pair rather than picking one, because a
 * view plane naming the same axis twice is not a plane.
 */
export function outOfPlaneAxis(horizontal: Axis, vertical: Axis): OutOfPlaneAxis {
  const [ax, ay, az] = UNIT[horizontal];
  const [bx, by, bz] = UNIT[vertical];
  const cross = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  const index = cross.findIndex((component) => component !== 0);
  if (index < 0) {
    throw new RangeError(
      `A view plane needs two different axes; got ${horizontal} and ${vertical}.`,
    );
  }
  return { axis: AXIS_ORDER[index]!, sign: cross[index]! > 0 ? 1 : -1 };
}

function plane(
  id: ViewPlaneId,
  label: string,
  horizontal: Axis,
  vertical: Axis,
  fanAxis: 'x' | 'y' | undefined,
  description: string,
): ViewPlane {
  return {
    id,
    label,
    horizontal,
    vertical,
    outward: outOfPlaneAxis(horizontal, vertical),
    description,
    fanAxis,
    axial: horizontal === 'z' || vertical === 'z',
  };
}

/**
 * The three views, and why each is drawn the way it is.
 *
 * Z runs right in both cross-sections and nowhere else: the optical axis is what
 * a layout is read along, and standing it upright to satisfy a naming rule would
 * make both of them unreadable. So the letters name the plane, not the screen —
 * the gizmo in the corner is what names the screen.
 *
 * The fan axis is the other half of choosing a plane. A meridional fan is spread
 * in y, so seen in the x–z plane every one of its rays lies flat on the axis;
 * the sagittal view has to be given a fan spread in x or it draws a single line
 * and calls it a lens.
 */
export const VIEW_PLANES: Record<ViewPlaneId, ViewPlane> = {
  YZ: plane(
    'YZ',
    'Y–Z',
    'z',
    'y',
    'y',
    'Meridional cross-section: the axis runs right, Y up, X into the screen. The plane the fields are specified in, and the one first-order optics is drawn in.',
  ),
  XZ: plane(
    'XZ',
    'X–Z',
    'z',
    'x',
    'x',
    'Sagittal cross-section: the axis runs right, X up, Y out of the screen. The plane at right angles to the fields, drawn with a fan spread in x.',
  ),
  XY: plane(
    'XY',
    'X–Y',
    'x',
    'y',
    undefined,
    'End-on, looking back along the axis from image space: X right, Y up, Z out of the screen. Surfaces are their rims and the rays are a pupil grid, so this is where a decenter or a tilt shows itself.',
  ),
};

/** Dropdown order: the designer's two cross-sections, then the end-on view. */
export const VIEW_PLANE_IDS: readonly ViewPlaneId[] = ['YZ', 'XZ', 'XY'];

/** A world point as the view sees it. */
export function projectToPlane(point: Positioned, view: ViewPlane): LayoutPoint {
  return { h: point[view.horizontal], v: point[view.vertical] };
}

/**
 * One world axis as it lands on the screen — what an orientation gizmo draws.
 *
 * Kept apart from {@link ViewPlane} because the 3-D view has one of these too,
 * and there it comes from the camera rather than from any fixed plane. The two
 * layouts then share a gizmo instead of each growing their own.
 */
export interface ProjectedAxis {
  readonly axis: Axis;
  /** Screen direction, `y` growing downward as SVG does. No longer than 1. */
  readonly x: number;
  readonly y: number;
  /** Along the view direction: +1 straight at the viewer, −1 straight away. */
  readonly toward: number;
}

/**
 * The three axes as a 2-D view plane sees them: two lying exactly along the
 * screen's own directions, and the third straight through it with no screen
 * length at all. Nothing is tilted to make that third one visible — a 2-D view
 * is a 2-D view, and the gizmo draws it as the vector symbol it is.
 */
export function viewPlaneAxes(view: ViewPlane): ProjectedAxis[] {
  return AXIS_ORDER.map((axis) => {
    if (axis === view.horizontal) {
      return { axis, x: 1, y: 0, toward: 0 };
    }
    if (axis === view.vertical) {
      return { axis, x: 0, y: -1, toward: 0 };
    }
    return { axis, x: 0, y: 0, toward: view.outward.sign };
  });
}

/** The world axes, in the order a gizmo lists them. */
export const AXES: readonly Axis[] = AXIS_ORDER;
