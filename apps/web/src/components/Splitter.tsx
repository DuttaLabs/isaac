import { useCallback, useRef, type CSSProperties } from 'react';
import { type Extent } from '../lib/tiling.ts';

/** How far one arrow-key press moves a divider, as a fraction of the whole. */
const KEY_STEP = 0.02;

/**
 * The draggable divider between two panels.
 *
 * A separator rather than a resize grip on the panel itself. The page does not
 * scroll, so a panel cannot simply grow — the space has to come from somewhere,
 * and saying *where* is exactly what a divider does and a corner grip does not.
 * It is also the difference between this and the floating windows Subrata
 * dislikes: nothing overlaps, nothing is lost behind anything, and the pieces
 * always tile the window exactly.
 *
 * Pointer capture, not a window listener: the drag keeps following the pointer
 * when it leaves the divider — which it does immediately — and it is released
 * automatically if the pointer is lost. `setPointerCapture` also gets this right
 * in the second window, where a listener on the opener's `window` would not.
 *
 * Keyboard-reachable, because a mouse-only layout control locks out anyone who
 * cannot use one, and `role="separator"` with `aria-valuenow` is what makes a
 * screen reader announce it as something adjustable rather than as decoration.
 */
export function Splitter({
  orientation,
  onResize,
  label,
  valueNow,
  span,
  style,
}: {
  /**
   * Which way the divider *runs*: `vertical` is an upright bar between two
   * side-by-side panels, matching `aria-orientation` and not the axis it moves
   * along, which is the opposite and the easy thing to get backwards.
   */
  orientation: 'vertical' | 'horizontal';
  /** The move, as a fraction of the container's length along the drag axis. */
  onResize: (delta: number) => void;
  label: string;
  /** Share of the container the panel before the divider currently has, 0–1. */
  valueNow: number;
  /**
   * How long this divider's own split is, along the direction it moves in.
   *
   * It used to measure its parent element, which was the split's grid; drawn
   * flat, every divider's parent is the whole workspace, so the split it belongs
   * to is no longer anything the DOM can be asked about. The tiling knows it, so
   * it is passed — resolved against the workspace at the moment of the drag,
   * because that is the only part of it that can change under the pointer.
   */
  span: Extent;
  /** Where it sits: the workspace is drawn flat, so every box is positioned. */
  style: CSSProperties;
}) {
  const dragging = useRef<{ start: number; extent: number } | null>(null);
  const vertical = orientation === 'vertical';

  const begin = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Only the primary button, and never a drag started by a stray middle
      // click, which in the 3-D view means orbit.
      if (event.button !== 0) {
        return;
      }
      // The workspace: what this divider's fractions are fractions *of*.
      const container = event.currentTarget.offsetParent;
      if (container === null) {
        return;
      }
      const box = container.getBoundingClientRect();
      const extent = span.fraction * (vertical ? box.width : box.height) + span.pixels;
      if (extent <= 0) {
        return;
      }
      dragging.current = { start: vertical ? event.clientX : event.clientY, extent };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [vertical, span],
  );

  const move = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragging.current;
      if (drag === null) {
        return;
      }
      const position = vertical ? event.clientX : event.clientY;
      const delta = (position - drag.start) / drag.extent;
      if (delta === 0) {
        return;
      }
      // The start moves with each report, so the deltas are increments rather
      // than a total measured from the beginning — which keeps the divider under
      // the pointer even after a clamp has refused part of a move.
      drag.start = position;
      onResize(delta);
    },
    [onResize, vertical],
  );

  const end = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      className={`splitter splitter-${orientation}`}
      style={style}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(valueNow * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        const back = vertical ? 'ArrowLeft' : 'ArrowUp';
        const forward = vertical ? 'ArrowRight' : 'ArrowDown';
        if (event.key === back) {
          onResize(-KEY_STEP);
        } else if (event.key === forward) {
          onResize(KEY_STEP);
        } else {
          return;
        }
        event.preventDefault();
      }}
    />
  );
}
