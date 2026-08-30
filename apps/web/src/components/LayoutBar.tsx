import { useRef, useState } from 'react';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { TextCell } from './TextCell.tsx';
import type { MenuPoint } from '../lib/context-menu.ts';
import {
  addLayout,
  deleteLayout,
  duplicateLayout,
  layoutFor,
  renameLayout,
  selectLayout,
  shownKey,
  type LayoutLibrary,
  type WindowId,
} from '../lib/layout-storage.ts';

/**
 * Which arrangement this window is showing, and what can be done to it.
 *
 * A strip of its own at the top of the workspace rather than a control in the
 * app bar, because **there are two windows and only one app bar**: the second
 * window picks its layout the same way, in the same place, and a control that
 * moved between the two would be one more thing to learn. It also names what it
 * belongs to — everything below the strip is the layout the strip names.
 *
 * The cost is a row of vertical space in the main window, which is real; it is
 * kept to one line of small text for exactly that reason.
 */
export function LayoutBar({
  library,
  which,
  mirrored,
  onLibrary,
}: {
  library: LayoutLibrary;
  which: WindowId;
  /** Both windows are open and showing this same layout, so edits land in both. */
  mirrored: boolean;
  onLibrary: (next: LayoutLibrary) => void;
}) {
  const key = shownKey(library, which);
  const current = layoutFor(library, which);
  const [menuAt, setMenuAt] = useState<MenuPoint | undefined>(undefined);
  /**
   * Renaming replaces the picker with a text box rather than opening a dialog.
   * It renames *whatever this window shows*, which is why nothing here carries a
   * key around: New and Duplicate both point the window at what they made, so
   * the box that opens after them is already on the new layout.
   */
  const [renaming, setRenaming] = useState(false);
  const more = useRef<HTMLButtonElement>(null);

  const only = library.layouts.length <= 1;
  const items: MenuItem[] = [
    {
      key: 'new',
      label: 'New layout',
      hint: 'Another arrangement, starting from the one Isaac opens with',
      onSelect: () => {
        onLibrary(addLayout(library, which));
        setRenaming(true);
      },
    },
    {
      key: 'duplicate',
      label: 'Duplicate layout',
      hint: 'Copy this arrangement under a name of its own',
      onSelect: () => {
        onLibrary(duplicateLayout(library, which, key));
        setRenaming(true);
      },
    },
    {
      key: 'rename',
      label: 'Rename layout',
      hint: 'The name is how this arrangement is picked again',
      onSelect: () => setRenaming(true),
    },
    {
      key: 'delete',
      label: 'Delete layout',
      // Set apart because it is the one item here that destroys something, and
      // the only one with no way back: the panels have an undo stack, and an
      // arrangement does not.
      startsGroup: true,
      disabled: only,
      hint: only
        ? 'The last layout is kept — there would be nothing left to show'
        : 'Remove this arrangement. Layouts are not on the undo stack.',
      onSelect: () => onLibrary(deleteLayout(library, key)),
    },
  ];

  return (
    <div className="layout-bar">
      <span className="hint">Layout</span>
      {renaming ? (
        // `focusout` bubbles where `blur` does not, so leaving the box by any
        // route — Enter, Escape, a click elsewhere — puts the picker back.
        <span className="layout-name" onBlur={() => setRenaming(false)}>
          <TextCell
            value={current?.name ?? ''}
            ariaLabel="Layout name"
            focusOnOpen
            onCommit={(name) => onLibrary(renameLayout(library, key, name))}
          />
        </span>
      ) : (
        <select
          className="layout-choice"
          aria-label="Layout"
          title="Which arrangement of panels this window shows"
          value={key}
          onChange={(event) => onLibrary(selectLayout(library, which, event.target.value))}
        >
          {library.layouts.map((layout) => (
            <option key={layout.key} value={layout.key}>
              {layout.name}
            </option>
          ))}
        </select>
      )}
      <button
        ref={more}
        type="button"
        className="layout-more"
        aria-label="Layout actions"
        aria-haspopup="menu"
        title="New, duplicate, rename or delete a layout"
        onClick={() => {
          const box = more.current?.getBoundingClientRect();
          setMenuAt(box === undefined ? { x: 0, y: 0 } : { x: box.left, y: box.bottom + 2 });
        }}
      >
        ⋯
      </button>
      {mirrored ? (
        // Said out loud, because both windows showing one layout is allowed and
        // the alternative — a split appearing in the other window unbidden —
        // reads as a bug.
        <span className="hint">shown in both windows</span>
      ) : null}
      {menuAt === undefined ? null : (
        <ContextMenu
          at={menuAt}
          heading={current?.name}
          items={items}
          onClose={() => setMenuAt(undefined)}
        />
      )}
    </div>
  );
}
