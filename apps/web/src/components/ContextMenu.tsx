import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { placeMenu, type MenuPoint } from '../lib/context-menu.ts';

/** One line of a context menu. */
export interface MenuItem {
  /** Stable within one menu; React's key and nothing else. */
  key: string;
  label: string;
  /** What it does — or, when it is unavailable, why not. Shown on hover. */
  hint?: string;
  /**
   * Offered but not available here. Shown greyed rather than hidden: a menu
   * whose items come and go teaches nobody what the panel can do, and the item
   * that vanished is the one the user was reaching for.
   */
  disabled?: boolean;
  /**
   * Draws a rule above this item, because it begins a new group of them.
   *
   * Carried by the item rather than sitting in the list as a separator of its
   * own, so the states that read as a bug cannot be written: a rule at the top
   * of the menu, one at the bottom, or two together. A separator is not a thing
   * to click — it exists only to say that what follows is different in kind —
   * and this way it is spelled as exactly that.
   */
  startsGroup?: boolean;
  onSelect: () => void;
}

/**
 * The menu a panel puts up in place of the browser's.
 *
 * Positioned in the viewport of whichever window it is in — `clientX`/`clientY`
 * are already relative to that one, and so is `position: fixed`, so a panel sent
 * to the second window needs nothing special. Everything it listens to comes
 * from its own document for the same reason.
 *
 * Dismissed generously: Escape, a click anywhere outside, a scroll, a resize, or
 * the window losing focus. A context menu points at the thing under it, and
 * every one of those moves that thing out from under it.
 */
export function ContextMenu({
  at,
  heading,
  items,
  onClose,
}: {
  /** Where the pointer was, in the menu's own window.  */
  at: MenuPoint;
  /** What the menu acts on, when the pointer has left it and nothing else says. */
  heading?: string;
  items: readonly MenuItem[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [where, setWhere] = useState<MenuPoint>(at);

  // Measured and moved before the browser paints, so a menu near an edge never
  // shows in the wrong place first. `at` is where it renders on the first pass;
  // a layout effect flushes the correction into the same frame.
  useLayoutEffect(() => {
    const element = menu.current;
    if (element === null) {
      return;
    }
    const view = element.ownerDocument.defaultView;
    if (view === null) {
      return;
    }
    const box = element.getBoundingClientRect();
    setWhere(
      placeMenu(
        at,
        { width: box.width, height: box.height },
        { width: view.innerWidth, height: view.innerHeight },
      ),
    );
    // The first item, so the menu can be driven from the keyboard the moment it
    // is up — and so focus is inside it, which is what makes Escape land here.
    element.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [at]);

  useEffect(() => {
    const element = menu.current;
    if (element === null) {
      return;
    }
    const doc = element.ownerDocument;
    const view = doc.defaultView;

    const onPointerDown = (event: Event): void => {
      if (event.target instanceof Node && !element.contains(event.target)) {
        onClose();
      }
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    // Captured, so it fires however the scroll happened and whichever box moved:
    // the menu is fixed to the viewport and the row it was opened on is not, so
    // a scroll would leave it pointing at a different surface than the one it names.
    doc.addEventListener('scroll', onClose, true);
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('keydown', onEscape);
    view?.addEventListener('blur', onClose);
    view?.addEventListener('resize', onClose);
    return () => {
      doc.removeEventListener('scroll', onClose, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('keydown', onEscape);
      view?.removeEventListener('blur', onClose);
      view?.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  /** Arrow keys walk the items, including the greyed ones — they say why. */
  const step = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0 && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const buttons = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (buttons.length === 0) {
      return;
    }
    const here = buttons.findIndex((button) => button === event.target);
    // Focus somewhere in the menu but not on an item — the container itself —
    // starts from just outside the end being stepped away from, so Down opens on
    // the first item and Up on the last. Taking -1 as an ordinary position would
    // make Up land on the second one.
    const from = here === -1 ? (delta > 0 ? buttons.length - 1 : 0) : here;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (from + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div
      ref={menu}
      className="context-menu"
      role="menu"
      aria-label={heading ?? 'Actions'}
      style={{ left: `${where.x}px`, top: `${where.y}px` }}
      onKeyDown={step}
    >
      {heading === undefined ? null : (
        // Presentational, because a `menu` may only contain menu items — the
        // text is the menu's accessible name above instead of a stray child.
        <div className="context-menu-heading" role="presentation">
          {heading}
        </div>
      )}
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.startsGroup === true ? (
            <div className="context-menu-separator" role="separator" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            // `aria-disabled`, not `disabled`: a disabled button cannot be
            // focused, so the arrow keys would skip the very item whose tooltip
            // says why it is unavailable.
            aria-disabled={item.disabled === true}
            title={item.hint}
            onClick={() => {
              if (item.disabled === true) {
                return;
              }
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
