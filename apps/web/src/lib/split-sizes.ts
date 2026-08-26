/**
 * Sizes for a row or column of panels, as grid `fr` weights.
 *
 * Weights rather than pixels, because the page no longer scrolls: the workspace
 * is exactly the height of the window, so what a divider does is *move space
 * between two neighbours* rather than make one bigger. Fractions survive a
 * window resize with the proportions the user chose; pixels would not.
 *
 * Only the two tracks either side of a divider move. Dragging one divider must
 * not shuffle panels the user was not touching, which is the thing that makes a
 * pane layout feel unpredictable.
 */

/** A track may not be squeezed below this share of the total. */
export const MINIMUM_TRACK = 0.12;

/**
 * Moves `delta` (as a fraction of the whole) from the track after the divider to
 * the track before it. Negative moves it the other way.
 *
 * The pair's combined weight is preserved exactly, so the tracks still sum to
 * what they summed to before and nothing outside the pair changes size. Clamped
 * so neither of the two can be squeezed away: a panel dragged to nothing cannot
 * be dragged back, because there is no edge left to grab.
 */
export function resizeTracks(
  sizes: readonly number[],
  divider: number,
  delta: number,
  minimum = MINIMUM_TRACK,
): number[] {
  const before = sizes[divider];
  const after = sizes[divider + 1];
  if (before === undefined || after === undefined) {
    return [...sizes];
  }

  const total = sizes.reduce((sum, size) => sum + size, 0);
  const pair = before + after;
  // The floor is a share of the whole row, not of the pair, so a panel's minimum
  // does not shrink just because its neighbour happens to be small.
  const floor = Math.min(minimum * total, pair / 2);
  const moved = clamp(before + delta * total, floor, pair - floor);

  const next = [...sizes];
  next[divider] = moved;
  next[divider + 1] = pair - moved;
  return next;
}

/** Even weights for `count` tracks — what a layout starts from with no preference. */
export function evenTracks(count: number): number[] {
  return new Array<number>(Math.max(count, 0)).fill(1);
}

/**
 * Grid template for a set of tracks with dividers between them: a track, a
 * divider, a track, and so on, ending on a track.
 *
 * The divider is a real track of its own rather than a border on a panel, so it
 * has a width to grab that does not depend on the panel next to it, and so the
 * fractions add up to the space the panels actually get.
 */
export function trackTemplate(sizes: readonly number[], dividerPx: number): string {
  return sizes.map((size) => `minmax(0, ${size}fr)`).join(` ${dividerPx}px `);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
