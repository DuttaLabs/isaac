import type { LayoutNode, Pane, SplitDirection } from './workspace.ts';

/**
 * The layout tree turned into a flat list of rectangles.
 *
 * The tree says how the panes are *arranged*; this says where each one lands.
 * Splitting them apart is the whole point, and it fixes something that was
 * invisible until it cost work: while the tree was drawn as nested boxes, a
 * pane's position in the React tree was its depth, and closing a pane moves its
 * sibling up a level. React ties a component's state to its position rather than
 * to its key, so the survivor was **rebuilt from scratch** — losing the lens
 * table's scroll, the 2-D view's pan and zoom, and the 3-D camera, every time a
 * neighbouring panel was closed.
 *
 * Drawn flat, every pane is a direct child of the workspace whatever the tree
 * does above it. Splitting and closing preserve the order of the panes that
 * remain, so React inserts and removes without ever *moving* one — which matters
 * because moving a DOM node loses its scroll position too, and a moved canvas
 * can lose its WebGL context.
 *
 * Positions are kept as a fraction plus a pixel correction, and rendered as a
 * `calc()`. Neither alone will do: the shares are proportions of a container
 * whose size is unknown here, and the dividers are a fixed thickness that must
 * not scale with it.
 */

/** A length: this share of the container, plus this many pixels. */
export interface Extent {
  readonly fraction: number;
  readonly pixels: number;
}

export interface Rect {
  readonly left: Extent;
  readonly top: Extent;
  readonly width: Extent;
  readonly height: Extent;
}

export interface TiledPane {
  readonly pane: Pane;
  readonly rect: Rect;
}

export interface TiledSplitter {
  /** The split's key: what `resizeSplit` is called with. */
  readonly key: string;
  readonly direction: SplitDirection;
  readonly ratio: number;
  readonly rect: Rect;
  /**
   * The length the two children *share* — the split minus the divider — which is
   * what a drag has to be measured against to become a change in ratio. The
   * divider's own rectangle is no use for this: it is the same few pixels
   * wherever it is.
   *
   * Minus the divider, not the whole split, because the ratio divides what is
   * left after the divider has taken its width. Measuring against the whole made
   * the divider lag the pointer by about a percent — invisible on one drag, and
   * wrong in a way that compounds.
   */
  readonly span: Extent;
  /** The subtree before the divider, for naming it. */
  readonly first: LayoutNode;
}

export interface Tiling {
  readonly panes: readonly TiledPane[];
  readonly splitters: readonly TiledSplitter[];
}

/**
 * Where everything goes.
 *
 * `gutter` is the divider's thickness and `inset` the margin around the whole
 * workspace — both in pixels, because both are fixed sizes that should not grow
 * with the window.
 */
export function tile(root: LayoutNode, gutter: number, inset: number): Tiling {
  const panes: TiledPane[] = [];
  const splitters: TiledSplitter[] = [];

  const place = (node: LayoutNode, rect: Rect): void => {
    if (node.kind === 'pane') {
      panes.push({ pane: node, rect });
      return;
    }

    const across = node.direction === 'row';
    const span = across ? rect.width : rect.height;
    // The two children share what is left once the divider has taken its share.
    const free: Extent = { fraction: span.fraction, pixels: span.pixels - gutter };
    const firstSize: Extent = {
      fraction: free.fraction * node.ratio,
      pixels: free.pixels * node.ratio,
    };
    const start = across ? rect.left : rect.top;
    const afterFirst = add(start, firstSize);
    const secondStart = add(afterFirst, { fraction: 0, pixels: gutter });
    const secondSize = subtract(free, firstSize);

    // Tree order, so the flat list keeps the order the panes are read in and a
    // split or a close never reorders the survivors.
    place(node.first, along(rect, across, start, firstSize));
    splitters.push({
      key: node.key,
      direction: node.direction,
      ratio: node.ratio,
      rect: along(rect, across, afterFirst, { fraction: 0, pixels: gutter }),
      span: free,
      first: node.first,
    });
    place(node.second, along(rect, across, secondStart, secondSize));
  };

  const whole: Extent = { fraction: 1, pixels: -2 * inset };
  const edge: Extent = { fraction: 0, pixels: inset };
  place(root, { left: edge, top: edge, width: whole, height: whole });

  return { panes, splitters };
}

/** The same rectangle with one axis replaced. */
function along(rect: Rect, across: boolean, start: Extent, size: Extent): Rect {
  return across ? { ...rect, left: start, width: size } : { ...rect, top: start, height: size };
}

const add = (a: Extent, b: Extent): Extent => ({
  fraction: a.fraction + b.fraction,
  pixels: a.pixels + b.pixels,
});

const subtract = (a: Extent, b: Extent): Extent => ({
  fraction: a.fraction - b.fraction,
  pixels: a.pixels - b.pixels,
});

/**
 * One length as CSS.
 *
 * Written as a `calc()` even when one half is zero, so every edge is the same
 * kind of value — and `calc(50% + -5px)` is not valid, hence the sign being
 * chosen rather than printed.
 */
export function cssLength({ fraction, pixels }: Extent): string {
  const percent = round(fraction * 100);
  const size = round(Math.abs(pixels));
  return `calc(${percent}% ${pixels < 0 ? '-' : '+'} ${size}px)`;
}

/** A rectangle as the four properties an absolutely positioned box needs. */
export function cssRect(rect: Rect): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: cssLength(rect.left),
    top: cssLength(rect.top),
    width: cssLength(rect.width),
    height: cssLength(rect.height),
  };
}

/** Enough precision that a divider lands on the pixel, without noise. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
