/**
 * The plumbing behind a second browser window: opening it, giving it the app's
 * stylesheet and theme, and putting it on the other display when there is one.
 *
 * A second *window* rather than a second tab, and a portal rather than a second
 * React root, because the panels sent there have to keep reading the same
 * design. A tab would have to be handed the `OpticalSystem` over a channel, and
 * it is a graph of class instances — `structuredClone` would deliver the numbers
 * without the prototypes, so the far side would be rebuilding the model and
 * re-tracing it, and the two copies could disagree. A portal keeps every
 * detached panel in the one React tree, reading the one `system`, traced once.
 *
 * React does attach its event system to a portal's container element and not
 * only to the root, which is what makes a portal into another document usable
 * at all: that document's events never reach the opener's root, so without it
 * every control in the second window would be inert.
 */

/**
 * Opened as a real popup, not a tab, because a tab cannot be dragged onto a
 * second monitor on its own. The size is a starting point; the window is the
 * user's to move and resize from there.
 */
const FEATURES = 'popup=yes,width=1280,height=900';

/**
 * Naming the window means a second call reuses it rather than stacking another
 * one behind the first.
 */
const WINDOW_NAME = 'isaac-secondary';

/** The class on the element panels are portalled into; styled in `theme.css`. */
const ROOT_CLASS = 'secondary-root';

export interface SecondaryWindowHandle {
  readonly window: Window;
  /** The element to portal into. */
  readonly container: HTMLElement;
}

/**
 * Opens the window and hands back the element to render into.
 *
 * Synchronous, and meant to be called straight from the click that asked for
 * it: a popup is only permitted while the user's activation is still live, and
 * an effect running under StrictMode would open one window, close it, and open
 * another.
 */
export function openSecondaryWindow(title: string): SecondaryWindowHandle {
  const opened = window.open('', WINDOW_NAME, FEATURES);
  if (opened === null) {
    throw new Error(
      'The browser blocked the second window. Allow pop-ups for this site, then try again.',
    );
  }

  const doc = opened.document;
  doc.title = title;
  doc.documentElement.lang = 'en';

  // Painted before the stylesheet has been copied across, so the window does not
  // open as a white rectangle in front of a dark one. The real colors arrive a
  // moment later and paint over these.
  const opener = getComputedStyle(document.body);
  doc.body.style.margin = '0';
  doc.body.style.background = opener.backgroundColor;
  doc.body.style.color = opener.color;

  // Reusing a window by name can hand back one still holding the container from
  // last time — after a reload of the opener, say.
  doc.querySelector(`.${ROOT_CLASS}`)?.remove();

  const container = doc.createElement('div');
  container.className = ROOT_CLASS;
  doc.body.appendChild(container);

  return { window: opened, container };
}

/**
 * Gives the window the app's CSS, and keeps giving it.
 *
 * `<link>` elements are copied once and left alone; re-cloning one would refetch
 * the file and flash. `<style>` elements are re-copied whenever the opener's
 * head changes, because that is how Vite serves CSS in development — it rewrites
 * those elements in place on every edit, so a one-off copy goes stale the first
 * time a stylesheet is touched.
 */
export function adoptStyles(target: Document): () => void {
  const styles: Element[] = [];

  const syncStyles = (): void => {
    for (const stale of styles.splice(0)) {
      stale.remove();
    }
    for (const style of document.head.querySelectorAll('style')) {
      const copy = target.importNode(style, true);
      target.head.appendChild(copy);
      styles.push(copy);
    }
  };

  for (const link of document.head.querySelectorAll('link[rel="stylesheet"]')) {
    target.head.appendChild(target.importNode(link, true));
  }
  syncStyles();

  // Watching the opener's head, and writing only into the target's, so this
  // cannot set itself off again.
  const observer = new MutationObserver(syncStyles);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

/**
 * Keeps `data-theme` on the second window's root in step with the first.
 *
 * That attribute is what `theme.css` switches palettes on. With the toggle on
 * "system" there is no attribute at all and only `prefers-color-scheme`
 * separates light from dark — a media query, which answers the same in both
 * windows without any help.
 */
export function mirrorTheme(target: Document): () => void {
  const source = document.documentElement;

  const apply = (): void => {
    const theme = source.getAttribute('data-theme');
    if (theme === null) {
      target.documentElement.removeAttribute('data-theme');
    } else {
      target.documentElement.setAttribute('data-theme', theme);
    }
  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(source, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/** The part of the Window Management API this needs, which TypeScript's DOM types do not carry. */
interface ScreenGeometry {
  readonly availLeft: number;
  readonly availTop: number;
  readonly availWidth: number;
  readonly availHeight: number;
}

interface ScreenDetails {
  readonly screens: readonly ScreenGeometry[];
  readonly currentScreen: ScreenGeometry;
}

interface PlacementWindow extends Window {
  getScreenDetails?: () => Promise<ScreenDetails>;
  /** True when more than one display is attached. Readable without permission. */
  readonly screen: Screen & { readonly isExtended?: boolean };
}

/** How far the window is inset from the edges of the display it is put on. */
const MARGIN = 40;

/**
 * Whether this browser can put a window on a display of our choosing, and
 * whether it has been allowed to.
 *
 * - `unsupported` — no Window Management API. Every browser but Chromium today.
 * - `single-display` — nowhere to move to.
 * - `prompt` — available, but the user has not been asked yet.
 * - `granted` / `denied` — they have.
 */
export type ScreenPlacement = 'unsupported' | 'single-display' | 'prompt' | 'granted' | 'denied';

export async function screenPlacementState(): Promise<ScreenPlacement> {
  const host = window as PlacementWindow;
  if (host.getScreenDetails === undefined) {
    return 'unsupported';
  }

  let permission: PermissionState = 'prompt';
  try {
    permission = (
      await navigator.permissions.query({ name: 'window-management' as PermissionName })
    ).state;
  } catch {
    // A browser with the API but not that permission name: ask and find out.
  }

  if (permission !== 'granted') {
    // `screen.isExtended` is all that can be read without asking, and it is only
    // a hint — this machine reports it true while `getScreenDetails` returns a
    // single screen. Good enough to decide whether asking is worth a prompt.
    return host.screen.isExtended === true ? permission : 'single-display';
  }

  // Granted, so the real list is readable, and the real list is the authority:
  // whether there is anywhere to move to is a question only it can answer.
  try {
    const details = await host.getScreenDetails();
    return details.screens.length > 1 ? 'granted' : 'single-display';
  } catch {
    return 'denied';
  }
}

/**
 * Moves the window onto a display other than the one the app is on.
 *
 * **Must be called from its own click when the permission has not been granted
 * yet.** `getScreenDetails` raises its prompt only while the user's activation
 * is live, and `window.open` consumes that activation — so asking on the way to
 * opening the window silently fails, having opened the window with the very
 * gesture the prompt needed. Once the permission is granted no activation is
 * required and the placement can ride along with the open.
 *
 * Throws rather than returning quietly. An earlier version swallowed every
 * failure on the grounds that the window was open and usable either way, and
 * what that bought was a feature that did nothing and said nothing about why.
 */
export async function moveToOtherScreen(target: Window): Promise<void> {
  const host = window as PlacementWindow;
  if (host.getScreenDetails === undefined) {
    throw new Error(
      'This browser cannot place a window on a chosen display. Drag the window across instead.',
    );
  }

  let details: ScreenDetails;
  try {
    details = await host.getScreenDetails();
  } catch (error) {
    throw new Error(
      `Chrome would not say where the displays are (${
        error instanceof Error ? error.name : String(error)
      }). Allow this site to manage windows on all your displays, or drag the window across.`,
    );
  }

  const elsewhere = details.screens.find((screen) => screen !== details.currentScreen);
  if (elsewhere === undefined) {
    throw new Error('There is only one display to put it on.');
  }
  if (target.closed) {
    return;
  }
  // Inset rather than filling the display: a window with no visible edge is an
  // awkward one to grab, and the size is the user's to settle anyway.
  target.moveTo(elsewhere.availLeft + MARGIN, elsewhere.availTop + MARGIN);
  target.resizeTo(elsewhere.availWidth - 2 * MARGIN, elsewhere.availHeight - 2 * MARGIN);
}
