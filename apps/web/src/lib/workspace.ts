import { resizeTracks } from './split-sizes.ts';
import { type PanelId } from './panels.ts';

/**
 * One panel on screen: which panel it shows, what share of its column it takes,
 * and a key of its own.
 *
 * The key is the point. A panel id no longer identifies a panel on screen, now
 * that the same panel may be open twice — and two copies are *meant* to be
 * indistinguishable in behavior, since they read the same design and the same
 * view settings. So everything that has to tell this one from that one — a
 * React key, which was sent to the second window, which was closed — names the
 * slot, and everything about what is *shown* names the panel.
 */
export interface Slot {
  readonly key: string;
  readonly panel: PanelId;
  readonly size: number;
}

/** A column of slots, itself taking a share of the workspace's width. */
export interface Column {
  readonly key: string;
  readonly size: number;
  readonly slots: readonly Slot[];
}

/**
 * The whole arrangement.
 *
 * `nextKey` is held here rather than in a counter outside so that every
 * operation stays a pure function of the workspace: duplicating a slot twice
 * gives two different keys without reaching for anything external, and the
 * tests can therefore check the operations rather than a side effect.
 *
 * Sizes are `fr` weights throughout, as in `split-sizes.ts` — which is also why
 * closing a slot needs no redistribution: the weights that remain still divide
 * the same space, so the survivors expand in the proportions they already had.
 */
export interface Workspace {
  readonly columns: readonly Column[];
  readonly nextKey: number;
}

export const DEFAULT_WORKSPACE: Workspace = {
  columns: [
    {
      key: 'column-a',
      size: 1,
      slots: [
        { key: 'slot-a', panel: 'source', size: 1 },
        { key: 'slot-b', panel: 'system', size: 1.5 },
        { key: 'slot-c', panel: 'firstOrder', size: 0.9 },
      ],
    },
    {
      key: 'column-b',
      size: 1.4,
      slots: [
        { key: 'slot-d', panel: 'layout2d', size: 1.5 },
        { key: 'slot-e', panel: 'analysis', size: 1 },
      ],
    },
  ],
  nextKey: 1,
};

/** Every slot, in the order they are arranged — top to bottom, left to right. */
export function slotsInOrder(workspace: Workspace): Slot[] {
  return workspace.columns.flatMap((column) => [...column.slots]);
}

/**
 * Which panels are on screen at all.
 *
 * Read by the analyses, which are gated on it: a Layout 3D panel that nobody
 * has opened should cost neither a pupil grid nor the ~900 kB of Three.js the
 * view is lazy-loaded to avoid.
 */
export function panelsOnScreen(workspace: Workspace): Set<PanelId> {
  return new Set(slotsInOrder(workspace).map((slot) => slot.panel));
}

export function isEmpty(workspace: Workspace): boolean {
  return workspace.columns.every((column) => column.slots.length === 0);
}

/** Turns one slot over to a different panel, leaving every other slot alone. */
export function setSlotPanel(workspace: Workspace, key: string, panel: PanelId): Workspace {
  return mapSlots(workspace, (slot) => (slot.key === key ? { ...slot, panel } : slot));
}

/**
 * Opens a second copy of a slot's panel directly beneath it.
 *
 * The new slot takes half of the one it came from, so no other panel moves —
 * splitting one panel in two is a local act, and a neighbour that jumped would
 * be a surprise nobody asked for.
 */
export function duplicateSlot(workspace: Workspace, key: string): Workspace {
  const columns = workspace.columns.map((column) => {
    const at = column.slots.findIndex((slot) => slot.key === key);
    if (at < 0) {
      return column;
    }
    const source = column.slots[at];
    if (source === undefined) {
      return column;
    }
    const half = source.size / 2;
    const copy: Slot = { key: `slot-${workspace.nextKey}`, panel: source.panel, size: half };
    const slots = [...column.slots];
    slots.splice(at, 1, { ...source, size: half }, copy);
    return { ...column, slots };
  });

  return { columns, nextKey: workspace.nextKey + 1 };
}

/**
 * Closes a slot, and the column with it if that was the last one in it.
 *
 * An empty column is not a thing anyone wants to look at or aim a divider at,
 * and leaving one would mean a strip of nothing that can never be filled — so
 * the remaining column simply takes the width. Closing the last slot of all
 * leaves an empty workspace, which `App` answers with a way to open a panel:
 * a close button that can strand the user with no way back is a trap, not a
 * feature.
 */
export function closeSlot(workspace: Workspace, key: string): Workspace {
  const columns = workspace.columns
    .map((column) => ({ ...column, slots: column.slots.filter((slot) => slot.key !== key) }))
    .filter((column) => column.slots.length > 0);

  return { ...workspace, columns };
}

/** Opens a panel in a workspace that has none, so an empty one is recoverable. */
export function addFirstPanel(workspace: Workspace, panel: PanelId): Workspace {
  return {
    columns: [
      {
        key: `column-${workspace.nextKey}`,
        size: 1,
        slots: [{ key: `slot-${workspace.nextKey}`, panel, size: 1 }],
      },
    ],
    nextKey: workspace.nextKey + 1,
  };
}

/** Moves width between two neighbouring columns. */
export function resizeColumns(workspace: Workspace, divider: number, delta: number): Workspace {
  const sizes = resizeTracks(
    workspace.columns.map((column) => column.size),
    divider,
    delta,
  );
  return {
    ...workspace,
    columns: workspace.columns.map((column, at) => ({ ...column, size: sizes[at] ?? column.size })),
  };
}

/** Moves height between two neighbouring slots of one column. */
export function resizeSlots(
  workspace: Workspace,
  columnKey: string,
  divider: number,
  delta: number,
): Workspace {
  return {
    ...workspace,
    columns: workspace.columns.map((column) => {
      if (column.key !== columnKey) {
        return column;
      }
      const sizes = resizeTracks(
        column.slots.map((slot) => slot.size),
        divider,
        delta,
      );
      return {
        ...column,
        slots: column.slots.map((slot, at) => ({ ...slot, size: sizes[at] ?? slot.size })),
      };
    }),
  };
}

function mapSlots(workspace: Workspace, change: (slot: Slot) => Slot): Workspace {
  return {
    ...workspace,
    columns: workspace.columns.map((column) => ({ ...column, slots: column.slots.map(change) })),
  };
}
