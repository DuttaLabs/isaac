/**
 * Right-click belongs to the panel under the pointer, not to the browser.
 *
 * Isaac is an application, not a document: the useful answer to a right-click on
 * a lens row is what can be done to that surface, and the platform's Back /
 * Reload / View source is noise in front of it. So the native menu is turned off
 * wherever the app draws, and each panel offers its own.
 */

/** A point in a window's own viewport coordinates — `clientX`/`clientY`. */
export interface MenuPoint {
  x: number;
  y: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

/** How close to an edge a menu may sit, in pixels. */
export const MENU_EDGE_MARGIN = 6;

/**
 * Suppresses the browser's own context menu in one document, and hands back the
 * undo.
 *
 * Takes the document rather than assuming `document`, because the app spans two
 * of them. The second window's background is a plain element created outside
 * React, so nothing there bubbles into the opener's tree and a handler on the
 * app's own root would leave the platform menu live on everything but the panels.
 */
export function suppressNativeContextMenu(doc: Document): () => void {
  const block = (event: MouseEvent): void => event.preventDefault();
  doc.addEventListener('contextmenu', block);
  return () => doc.removeEventListener('contextmenu', block);
}

/**
 * Where a menu opened at `at` actually goes, so the whole of it is on screen.
 *
 * An axis that would run off the far edge is **flipped** to the other side of
 * the pointer rather than merely slid back, which is what every platform menu
 * does and for a good reason: sliding leaves the pointer in the middle of the
 * menu, hovering an item nobody aimed at, and one twitch away from choosing it.
 * Flipping keeps the pointer on a corner.
 *
 * Sliding is still the fallback, for a menu with nowhere to flip to — taller
 * than the window it is in, say. Then it is clamped to the near edge and the
 * user scrolls it with the keyboard.
 */
export function placeMenu(
  at: MenuPoint,
  size: MenuSize,
  viewport: MenuSize,
  margin: number = MENU_EDGE_MARGIN,
): MenuPoint {
  return {
    x: fitAxis(at.x, size.width, viewport.width, margin),
    y: fitAxis(at.y, size.height, viewport.height, margin),
  };
}

function fitAxis(start: number, size: number, extent: number, margin: number): number {
  const flipped = start + size + margin > extent ? start - size : start;
  return Math.max(margin, Math.min(flipped, extent - size - margin));
}
