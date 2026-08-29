import { type PanelId } from './panels.ts';
import { defaultSettings, type PanelSettings } from './panel-settings.ts';

/**
 * The arrangement of panels, as a binary space partition.
 *
 * A pane is either something on screen or a split of two smaller panes, and
 * nothing else. That one rule is what makes every operation local: splitting a
 * pane touches only that pane, closing one gives its space to its sibling and to
 * nothing else, and a divider moves space between exactly the two children it
 * separates. Every panel on screen is a leaf, and the leaves tile the window
 * exactly — no overlap, nothing behind anything, no gaps.
 *
 * It replaces a fixed two-level arrangement of columns holding slots, which
 * could express only one shape of layout: stacks side by side, with no way to
 * add a column and no way to put two panels beside each other inside one. A tree
 * has no such ceiling, and costs less rather than more — the whole of it is
 * `Pane | Split`.
 */

/**
 * How a split lays its two children out — the *arrangement*, never the cut.
 * `row` puts them side by side with an upright divider between; `column` stacks
 * them with a flat one. Named this way because "a horizontal split" means
 * opposite things to different people, and this cannot be read two ways.
 */
export type SplitDirection = 'row' | 'column';

/** A leaf: one panel on screen, or a blank pane waiting to be told what to show. */
export interface Pane {
  readonly kind: 'pane';
  readonly key: string;
  /**
   * What it shows. `undefined` is a **blank** pane — the far half of a fresh
   * split, offering the panel list and nothing else. A split has to put
   * *something* in its second child, and a blank is the honest something: a copy
   * of the panel just split would be a guess, and half of them would be
   * immediately replaced.
   */
  readonly panel: PanelId | undefined;
  /**
   * What this copy of the panel is set to — which plane a Layout 2D is drawn
   * in, how many rays it traces, which fields it narrows to.
   *
   * On the pane rather than on `App` because **output panels are allowed to
   * differ**: two Layout 2D panels exist so that one can show X–Z while the
   * other shows Y–Z, and a single app-wide "which plane" is exactly what
   * prevented that. Input panels — the source object, the lens grid — have no
   * settings here and mirror each other as they always did, because there is one
   * design and two views of it disagreeing would be a lie.
   *
   * Being *inside* the tree is also what makes a saved arrangement worth
   * saving: the panels come back in their places with their plots still set the
   * way they were left. `undefined` means untouched defaults, which is what a
   * blank pane and every input panel carry.
   */
  readonly settings?: PanelSettings;
}

/** A branch: two panes, in some direction, sharing the space they were given. */
export interface Split {
  readonly kind: 'split';
  readonly key: string;
  readonly direction: SplitDirection;
  /**
   * The share of this split taken by `first`, strictly between 0 and 1; `second`
   * takes the rest.
   *
   * One number rather than a weight on each child, so "the two together are
   * exactly the parent" is not an invariant anyone has to maintain — it is the
   * only thing the type can say. A pair of weights could drift apart; a ratio
   * cannot.
   */
  readonly ratio: number;
  readonly first: LayoutNode;
  readonly second: LayoutNode;
}

export type LayoutNode = Pane | Split;

/**
 * The whole arrangement.
 *
 * `nextKey` is held here rather than in a counter outside so that every
 * operation stays a pure function of the workspace: splitting the same pane
 * twice gives different keys without reaching for anything external, and the
 * tests can therefore check the operations rather than a side effect.
 *
 * The root always exists. Closing the only pane leaves it **blank** rather than
 * removing it: a close that strands the user with nothing and no way back is a
 * trap, and a blank pane already knows how to offer the panel list.
 */
export interface Workspace {
  readonly root: LayoutNode;
  readonly nextKey: number;
}

/** Neither side of a split may be squeezed below this share of it. */
export const MINIMUM_RATIO = 0.12;

const pane = (key: string, panel: PanelId | undefined): Pane => ({ kind: 'pane', key, panel });

const split = (
  key: string,
  direction: SplitDirection,
  ratio: number,
  first: LayoutNode,
  second: LayoutNode,
): Split => ({ kind: 'split', key, direction, ratio, first, second });

/**
 * The layout Isaac opens with: the design down the left, the pictures down the
 * right. The same arrangement the fixed two-column version shipped, written as
 * the tree it always was — so nothing moves on screen, and it is now one layout
 * among the many the tree can hold rather than the only one it can express.
 */
export const DEFAULT_WORKSPACE: Workspace = {
  root: split(
    'split-root',
    'row',
    0.42,
    split(
      'split-left',
      'column',
      0.3,
      pane('pane-source', 'source'),
      split(
        'split-left-lower',
        'column',
        0.62,
        pane('pane-system', 'system'),
        pane('pane-first-order', 'firstOrder'),
      ),
    ),
    split(
      'split-right',
      'column',
      0.6,
      pane('pane-layout-2d', 'layout2d'),
      // The two analyses side by side, which is the arrangement the old combined
      // Analysis panel was imitating with a grid inside one panel. As panes they
      // can be resized against each other, closed separately, or turned over to
      // something else — none of which a grid inside a panel could do.
      split('split-plots', 'row', 0.5, pane('pane-ray-fan', 'rayFan'), pane('pane-spot', 'spot')),
    ),
  ),
  nextKey: 1,
};

/**
 * What the second window opens with: the lens grid over the layout.
 *
 * A window of its own rather than a place panels are *sent* to, and this is what
 * makes that worth having — a second display is wide, so the grid gets every
 * column at once without scrolling sideways, and the layout below it is what a
 * designer watches while editing. It is a starting point, not a fixture: the
 * same split, close and choose controls work there, so it is rearranged exactly
 * like the first window.
 */
export const DEFAULT_SECONDARY_WORKSPACE: Workspace = {
  root: split(
    'split-second-root',
    'column',
    0.5,
    pane('pane-second-system', 'system'),
    pane('pane-second-layout', 'layout2d'),
  ),
  nextKey: 1,
};

/** Every pane, left to right and top to bottom — the order they are arranged in. */
export function panesInOrder(workspace: Workspace): Pane[] {
  const found: Pane[] = [];
  const walk = (node: LayoutNode): void => {
    if (node.kind === 'pane') {
      found.push(node);
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  walk(workspace.root);
  return found;
}

/**
 * Which panels are on screen at all.
 *
 * Read by the analyses, which are gated on it: a Layout 3D panel that nobody
 * has opened should cost neither a pupil grid nor the ~900 kB of Three.js the
 * view is lazy-loaded to avoid.
 */
export function panelsOnScreen(workspace: Workspace): Set<PanelId> {
  const shown = new Set<PanelId>();
  for (const found of panesInOrder(workspace)) {
    if (found.panel !== undefined) {
      shown.add(found.panel);
    }
  }
  return shown;
}

/** True while the workspace is one blank pane — nothing open, and a way back. */
export function isEmpty(workspace: Workspace): boolean {
  return workspace.root.kind === 'pane' && workspace.root.panel === undefined;
}

/**
 * Turns one pane over to a different panel, leaving every other pane alone.
 *
 * The settings go with the old panel rather than being kept: they describe that
 * panel and mean nothing to the new one, and carrying them across is how a
 * Layout 2D's plane ends up half-applied to a spot diagram. A pane turned back
 * again therefore starts fresh, which is the honest reading of having replaced
 * what was there.
 */
export function setPanePanel(workspace: Workspace, key: string, panel: PanelId): Workspace {
  return {
    ...workspace,
    root: mapNode(workspace.root, (node) =>
      node.kind === 'pane' && node.key === key
        ? { ...node, panel, settings: defaultSettings(panel) }
        : node,
    ),
  };
}

/**
 * Changes what one pane is set to.
 *
 * Takes the settings rather than a change to them so that it stays a pure
 * function of the workspace, like every other operation here — the caller reads
 * the pane's current settings through `settingsOf`, which is where the defaults
 * for anything missing are filled in.
 */
export function setPaneSettings(
  workspace: Workspace,
  key: string,
  settings: PanelSettings,
): Workspace {
  return {
    ...workspace,
    root: mapNode(workspace.root, (node) =>
      node.kind === 'pane' && node.key === key ? { ...node, settings } : node,
    ),
  };
}

/**
 * Splits one pane in two, down the middle.
 *
 * The pane stays where it is, keeping its key — so it keeps its React identity,
 * its scroll position and its place in the second window — and the new blank one
 * takes the far half: the right of a `row`, the bottom of a `column`. Nothing
 * outside the split moves at all, which is the property that makes splitting
 * safe to do while working.
 */
export function splitPane(workspace: Workspace, key: string, direction: SplitDirection): Workspace {
  let made = false;
  const root = mapNode(workspace.root, (node) => {
    if (node.kind !== 'pane' || node.key !== key) {
      return node;
    }
    made = true;
    return split(
      `split-${workspace.nextKey}`,
      direction,
      0.5,
      node,
      pane(`pane-${workspace.nextKey}`, undefined),
    );
  });
  return made ? { root, nextKey: workspace.nextKey + 1 } : workspace;
}

/**
 * Closes a pane. Its sibling takes all of its space, and nothing else moves.
 *
 * That is the whole of it: the split above the pane is replaced by the other
 * child, which inherits the space the pair held together. Only one panel on
 * screen changes size, which is what makes closing readable — a redistribution
 * that nudges every panel at once leaves the user hunting for what moved.
 *
 * Closing the last pane blanks it rather than removing it, so the workspace is
 * never a dead end.
 */
export function closePane(workspace: Workspace, key: string): Workspace {
  if (workspace.root.kind === 'pane') {
    return workspace.root.key === key
      ? { ...workspace, root: pane(workspace.root.key, undefined) }
      : workspace;
  }
  const root = dropPane(workspace.root, key);
  return root === undefined ? workspace : { ...workspace, root };
}

/**
 * Moves the divider of one split by `delta`, a fraction of that split's own
 * extent along the direction it divides.
 *
 * Clamped so neither side can be squeezed away: a panel dragged to nothing
 * cannot be dragged back, because there would be no edge left to grab.
 */
export function resizeSplit(workspace: Workspace, key: string, delta: number): Workspace {
  return {
    ...workspace,
    root: mapNode(workspace.root, (node) =>
      node.kind === 'split' && node.key === key
        ? { ...node, ratio: clamp(node.ratio + delta, MINIMUM_RATIO, 1 - MINIMUM_RATIO) }
        : node,
    ),
  };
}

/** Opens a panel in a blank pane — how an emptied workspace is recovered. */
export function addFirstPanel(workspace: Workspace, panel: PanelId): Workspace {
  return workspace.root.kind === 'pane'
    ? { ...workspace, root: { ...workspace.root, panel, settings: defaultSettings(panel) } }
    : workspace;
}

/** The pane with this key, if it is still on screen. */
export function findPane(workspace: Workspace, key: string): Pane | undefined {
  return panesInOrder(workspace).find((found) => found.key === key);
}

/**
 * Rebuilds the tree with `change` applied to every node, bottom up.
 *
 * Returns the very same object where nothing under a node changed, so React sees
 * an unchanged subtree and re-renders only the branch that actually moved.
 */
function mapNode(node: LayoutNode, change: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (node.kind === 'pane') {
    return change(node);
  }
  const first = mapNode(node.first, change);
  const second = mapNode(node.second, change);
  const rebuilt =
    first === node.first && second === node.second ? node : { ...node, first, second };
  return change(rebuilt);
}

/**
 * The tree with one pane gone, or `undefined` if it was not in here — which is
 * what tells the caller apart from a tree that legitimately came back unchanged.
 */
function dropPane(node: LayoutNode, key: string): LayoutNode | undefined {
  if (node.kind === 'pane') {
    return undefined;
  }
  if (node.first.kind === 'pane' && node.first.key === key) {
    return node.second;
  }
  if (node.second.kind === 'pane' && node.second.key === key) {
    return node.first;
  }
  const first = dropPane(node.first, key);
  if (first !== undefined) {
    return { ...node, first };
  }
  const second = dropPane(node.second, key);
  return second === undefined ? undefined : { ...node, second };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
