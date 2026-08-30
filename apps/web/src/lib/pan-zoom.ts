/**
 * The pannable, zoomable window onto a 2-D drawing — an SVG `viewBox`, and the
 * one rule that keeps it somewhere useful.
 *
 * Kept out of the component because it is arithmetic with a right answer, and
 * because every wrong answer still draws *a* picture: a view panned into empty
 * space renders perfectly and shows nothing, which looks like a blank panel
 * rather than like a bug.
 */

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A view moved back until it still overlaps the drawing.
 *
 * The rule is that the view's **center** stays inside the fitted box — the
 * region the drawing was laid out in, from (0, 0) to (width, height). It is the
 * simplest rule that cannot lose the picture, and it behaves sensibly at both
 * ends of the zoom: wound in, the view is small and can reach any part of the
 * drawing but not past its edge, the way a map pans; wound out, the view is
 * larger than the drawing and can push it to the edge of the panel but never
 * out of it.
 *
 * Without it a drag simply keeps going, and the drawing leaves the panel with no
 * hint of which way it went — the only way back is Reset view, which is a poor
 * thing to have to discover.
 */
export function clampPan(view: ViewBox, fitted: { width: number; height: number }): ViewBox {
  return {
    ...view,
    x: clampCenter(view.x, view.width, fitted.width),
    y: clampCenter(view.y, view.height, fitted.height),
  };
}

function clampCenter(start: number, extent: number, limit: number): number {
  const half = extent / 2;
  return Math.min(Math.max(start + half, 0), limit) - half;
}
