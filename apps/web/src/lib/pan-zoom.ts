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
 * A view moved back until it and the drawing still overlap.
 *
 * The rule: **whichever of the two is smaller, its center must lie inside the
 * other.** Wound in, the view is smaller, so the view's center stays on the
 * drawing and every part of it can be reached — the way a map pans. Wound out,
 * the drawing is smaller, so the drawing's center stays inside the view and it
 * can be put anywhere in the panel. Without a rule of some kind a drag simply
 * keeps going and the drawing leaves the panel with no hint of which way it
 * went, recoverable only by Reset view, which is a poor thing to have to
 * discover.
 *
 * **The old rule was only the first half of that**, and applied it at every
 * zoom: the view's center was held inside the fitted box whether or not the view
 * was the smaller thing. That is a limit stated in drawing units, so the room it
 * left on *screen* shrank in step with the drawing — the center could travel
 * `limit` units at any zoom, which is the whole panel when fitted and an eighth
 * of it wound out eight times. So the panel got bigger while the room to move
 * got smaller, an invisible box that changed size with the wheel and nothing on
 * screen to explain it. Under the symmetric rule the travel is exactly one
 * panel's width at every zoom.
 */
export function clampPan(view: ViewBox, fitted: { width: number; height: number }): ViewBox {
  return {
    ...view,
    x: clampOverlap(view.x, view.width, fitted.width),
    y: clampOverlap(view.y, view.height, fitted.height),
  };
}

/**
 * The view spans `[start, start + extent]` and the drawing `[0, limit]`. Half
 * the shorter of the two has to stay within the other, which is the same thing
 * as putting the shorter one's center inside the longer.
 */
function clampOverlap(start: number, extent: number, limit: number): number {
  const keep = Math.min(limit, extent) / 2;
  return Math.min(Math.max(start, keep - extent), limit - keep);
}
