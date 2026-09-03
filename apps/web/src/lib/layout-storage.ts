import { PANELS, type PanelId } from './panels.ts';
import { defaultSettings, settingsOf, type PanelSettings } from './panel-settings.ts';
import {
  DEFAULT_SECONDARY_WORKSPACE,
  DEFAULT_WORKSPACE,
  MINIMUM_RATIO,
  type LayoutNode,
  type SplitDirection,
  type Workspace,
} from './workspace.ts';

/**
 * The panel arrangement, kept between sessions.
 *
 * `localStorage`, not a cookie: a cookie is sent with every request and caps out
 * around 4 KB, while this is purely client-side and never needs to reach a
 * server. It works at all because a `Workspace` is plain data — strings, numbers
 * and a handful of string unions — so `JSON.stringify` is lossless on it. That
 * is emphatically *not* true of `OpticalSystem`, whose class instances would
 * come back as bare numbers with no prototypes.
 *
 * **A library from the start, holding one layout per window.** Named layouts a
 * user can switch between are the point of this eventually, and writing the
 * shape now means there will be no stored format to migrate when the picker
 * arrives — only a UI to add. The cost today is one level of nesting and a name
 * nobody sees.
 */

export interface NamedLayout {
  readonly key: string;
  readonly name: string;
  readonly workspace: Workspace;
}

export interface LayoutLibrary {
  readonly layouts: readonly NamedLayout[];
  /** Which layout the main window shows. */
  readonly main: string;
  /** Which layout the second window shows. */
  readonly secondary: string;
  /** Mints the next layout key, the way `Workspace.nextKey` mints pane keys. */
  readonly nextKey: number;
}

/**
 * The storage key carries the format version.
 *
 * In the key rather than only inside the value, so a future format is a
 * *different key*: an old Isaac left open in another tab keeps reading and
 * writing its own, and neither version corrupts the other's. The version inside
 * the value is still checked, because a hand-edited or truncated entry can carry
 * anything at all.
 */
export const STORAGE_KEY = 'isaac.layout.v1';
const VERSION = 1;

/**
 * What a first-time Isaac holds: the arrangement it opens with, and the wide one
 * the second window starts in.
 *
 * They are named for what they *are* rather than for where they are shown, now
 * that either window can be pointed at either — "Second display" was a fair name
 * while a layout belonged to a window and became a wrong one the moment it did
 * not.
 */
export const DEFAULT_LIBRARY: LayoutLibrary = {
  layouts: [
    { key: 'layout-main', name: 'Design', workspace: DEFAULT_WORKSPACE },
    { key: 'layout-second', name: 'Grid and layout', workspace: DEFAULT_SECONDARY_WORKSPACE },
  ],
  main: 'layout-main',
  secondary: 'layout-second',
  nextKey: 1,
};

/** The workspace a window is showing, or its default if the key has gone. */
export function workspaceIn(library: LayoutLibrary, key: string, fallback: Workspace): Workspace {
  return library.layouts.find((layout) => layout.key === key)?.workspace ?? fallback;
}

/** The library with one layout's arrangement replaced. */
export function withWorkspace(
  library: LayoutLibrary,
  key: string,
  workspace: Workspace,
): LayoutLibrary {
  return {
    ...library,
    layouts: library.layouts.map((layout) =>
      layout.key === key ? { ...layout, workspace } : layout,
    ),
  };
}

/**
 * Which window a layout is being shown in. There are two, and only two.
 *
 * A layout is not *owned* by a window — it is an arrangement, and either window
 * can be pointed at any of them. That is the whole reason the library is a flat
 * list with two pointers into it rather than one layout per window.
 */
export type WindowId = 'main' | 'secondary';

/** Which layout a window is showing, if it is still in the library. */
export function layoutFor(library: LayoutLibrary, window: WindowId): NamedLayout | undefined {
  return library.layouts.find((layout) => layout.key === shownKey(library, window));
}

/** The key a window is pointed at, whether or not a layout still answers to it. */
export function shownKey(library: LayoutLibrary, window: WindowId): string {
  return window === 'main' ? library.main : library.secondary;
}

/**
 * Points one window at a layout.
 *
 * **Both windows may name the same one**, and then they mirror: one tree drawn
 * twice, so a split made in either is a split in both. That is the honest
 * reading of "both windows are showing this layout". Forking a private copy
 * instead would leave two different arrangements wearing one name, which is the
 * one thing a named layout exists to prevent.
 */
export function selectLayout(library: LayoutLibrary, window: WindowId, key: string): LayoutLibrary {
  return library.layouts.some((layout) => layout.key === key)
    ? pointAt(library, window, key)
    : library;
}

/**
 * Adds a layout and shows it in that window.
 *
 * The window is pointed at it here rather than by a second call, so the new
 * layout's key never has to be handed back and threaded around: whatever this
 * window now shows *is* the new one, which is also what lets the rename box open
 * on it without knowing its key.
 *
 * A new layout starts from the arrangement Isaac opens with rather than from a
 * blank pane. Building one up from nothing is the rare case, and *Duplicate* is
 * there for starting from what is already on screen.
 */
export function addLayout(
  library: LayoutLibrary,
  window: WindowId,
  workspace: Workspace = DEFAULT_WORKSPACE,
): LayoutLibrary {
  return insertLayout(library, window, freeName('Layout', library.layouts), workspace);
}

/** Copies a layout under a name of its own, and shows the copy in that window. */
export function duplicateLayout(
  library: LayoutLibrary,
  window: WindowId,
  key: string,
): LayoutLibrary {
  const found = library.layouts.find((layout) => layout.key === key);
  return found === undefined
    ? library
    : insertLayout(
        library,
        window,
        freeName(`${found.name} copy`, library.layouts),
        found.workspace,
      );
}

/**
 * Renames a layout.
 *
 * An empty name is refused, and whitespace is collapsed, for the same reason the
 * lens name's is: the name is the only thing telling one entry in the list from
 * another, so a blank one would be a layout the user cannot pick again. Names
 * are otherwise free — two layouts may share one, since the key is what
 * identifies them, and quietly numbering what someone just typed would be worse
 * than letting them see the duplicate and fix it.
 */
export function renameLayout(library: LayoutLibrary, key: string, name: string): LayoutLibrary {
  const clean = name.trim().replace(/\s+/g, ' ');
  return clean === ''
    ? library
    : {
        ...library,
        layouts: library.layouts.map((layout) =>
          layout.key === key ? { ...layout, name: clean } : layout,
        ),
      };
}

/**
 * Removes a layout. The last one is kept, whatever is asked.
 *
 * A window showing what has gone falls to the layout that took its place in the
 * list — its neighbour below, or the new last one — rather than to the start of
 * the library: closing a layout should leave the user next to where they were.
 */
export function deleteLayout(library: LayoutLibrary, key: string): LayoutLibrary {
  const at = library.layouts.findIndex((layout) => layout.key === key);
  if (at === -1 || library.layouts.length <= 1) {
    return library;
  }
  const layouts = library.layouts.filter((layout) => layout.key !== key);
  const neighbour = layouts[Math.min(at, layouts.length - 1)]!.key;
  const kept = (shown: string): string => (shown === key ? neighbour : shown);
  return { ...library, layouts, main: kept(library.main), secondary: kept(library.secondary) };
}

function insertLayout(
  library: LayoutLibrary,
  window: WindowId,
  name: string,
  workspace: Workspace,
): LayoutLibrary {
  const key = `layout-${library.nextKey}`;
  return pointAt(
    {
      ...library,
      layouts: [...library.layouts, { key, name, workspace }],
      nextKey: library.nextKey + 1,
    },
    window,
    key,
  );
}

/**
 * Written out rather than as a computed key, because `{ ...library, [window]: key }`
 * widens both fields to `string | undefined` under a union-typed key — a shape
 * the library type does not have.
 */
function pointAt(library: LayoutLibrary, window: WindowId, key: string): LayoutLibrary {
  return {
    ...library,
    main: window === 'main' ? key : library.main,
    secondary: window === 'secondary' ? key : library.secondary,
  };
}

/** A name nothing else in the library is using: the stem, then the stem and a number. */
function freeName(stem: string, layouts: readonly NamedLayout[]): string {
  const taken = new Set(layouts.map((layout) => layout.name));
  if (!taken.has(stem)) {
    return stem;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export function serializeLibrary(library: LayoutLibrary): string {
  return JSON.stringify({ version: VERSION, ...library });
}

/**
 * A stored library, read back — **never trusting the parse**.
 *
 * `JSON.parse` returns `any`, so a value written by an older Isaac type-checks
 * perfectly and renders nothing, which looks like a bug in the app rather than
 * in the storage. Everything below is therefore checked, and the rule throughout
 * is **repair rather than reject**: a pane naming a panel that no longer exists
 * is blanked and keeps its place, a ratio out of range is clamped. Losing the
 * arrangement someone built over one bad value would be the worse failure.
 *
 * Two things cannot be repaired and drop the whole layout: a tree that is not a
 * tree, and **duplicate pane keys** — React identifies a pane by its key, so
 * duplicates would silently merge two panes into one.
 */
export function readLibrary(raw: string | null): LayoutLibrary {
  if (raw === null || raw === '') {
    return DEFAULT_LIBRARY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LIBRARY;
  }
  if (!isRecord(parsed) || parsed.version !== VERSION || !Array.isArray(parsed.layouts)) {
    return DEFAULT_LIBRARY;
  }

  const layouts: NamedLayout[] = [];
  for (const entry of parsed.layouts) {
    const layout = readLayout(entry);
    if (layout !== undefined) {
      layouts.push(layout);
    }
  }
  if (layouts.length === 0) {
    return DEFAULT_LIBRARY;
  }

  // A window pointing at a layout that did not survive falls back to the first
  // one rather than to nothing: there is always something to show.
  const has = (key: unknown): key is string =>
    typeof key === 'string' && layouts.some((layout) => layout.key === key);
  const first = layouts[0]!.key;

  return {
    layouts,
    main: has(parsed.main) ? parsed.main : first,
    secondary: has(parsed.secondary) ? parsed.secondary : first,
    nextKey: countFrom(
      parsed.nextKey,
      layouts.map((layout) => layout.key),
    ),
  };
}

function readLayout(value: unknown): NamedLayout | undefined {
  if (!isRecord(value) || typeof value.key !== 'string') {
    return undefined;
  }
  const workspace = readWorkspace(value.workspace);
  if (workspace === undefined) {
    return undefined;
  }
  return {
    key: value.key,
    name: typeof value.name === 'string' && value.name.trim() !== '' ? value.name : 'Layout',
    workspace,
  };
}

/**
 * Checks an arrangement that came from outside this build.
 *
 * Exported because a workspace arriving over a *network* needs exactly the
 * hardening one arriving from `localStorage` does, and for the same reason:
 * `JSON.parse` returns `any`, so a tree written by an older or newer Isaac
 * type-checks perfectly and renders nothing. Repair rather than reject — a pane
 * naming a panel this build lacks is blanked and keeps its place — except for
 * the two faults that cannot be repaired: a tree that is not a tree, and
 * duplicate pane keys, which would silently merge two panes into one.
 */
export function readWorkspace(value: unknown): Workspace | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const seen: string[] = [];
  const root = readNode(value.root, seen);
  if (root === undefined) {
    return undefined;
  }
  // Keys are how React tells one pane from another, and how every workspace
  // operation names its target. A duplicate is unrepairable.
  if (new Set(seen).size !== seen.length) {
    return undefined;
  }
  return { root, nextKey: countFrom(value.nextKey, seen) };
}

function readNode(value: unknown, seen: string[]): LayoutNode | undefined {
  if (!isRecord(value) || typeof value.key !== 'string') {
    return undefined;
  }

  if (value.kind === 'pane') {
    seen.push(value.key);
    // A panel this Isaac does not have — renamed, or removed — blanks the pane
    // and keeps its place, so the arrangement survives losing one panel.
    const panel = PANELS.find((known) => known === value.panel);
    const settings = panel === undefined ? undefined : readSettings(value.settings, panel);
    // The key is left off rather than set to `undefined`, so a pane that was
    // never touched comes back identical to the one that was written — which is
    // what lets the round trip be checked for equality rather than for
    // equivalence.
    return settings === undefined
      ? { kind: 'pane', key: value.key, panel }
      : { kind: 'pane', key: value.key, panel, settings };
  }

  if (value.kind !== 'split') {
    return undefined;
  }
  const first = readNode(value.first, seen);
  const second = readNode(value.second, seen);
  if (first === undefined || second === undefined) {
    return undefined;
  }
  const direction: SplitDirection = value.direction === 'column' ? 'column' : 'row';
  return {
    kind: 'split',
    key: value.key,
    direction,
    ratio: clampRatio(value.ratio),
    first,
    second,
  };
}

/**
 * A pane's settings, field by field.
 *
 * Built by walking the *defaults*, so a value is kept only when it is there and
 * of the right type, and anything new gains its default automatically. That is
 * the same merge `settingsOf` does at read time, done once on the way in so a
 * stored `raysPerFan: "banana"` never reaches a trace.
 */
function readSettings(value: unknown, panel: PanelId): PanelSettings | undefined {
  const defaults = defaultSettings(panel);
  // Nothing stored, or settings belonging to some other panel: `undefined` is
  // the model's own word for "untouched, use the defaults", so saying it here
  // keeps a pane that was never adjusted exactly as small as it was written.
  if (defaults === undefined || !isRecord(value) || value.panel !== panel) {
    return undefined;
  }
  const kept: Record<string, unknown> = { panel };
  for (const [name, fallback] of Object.entries(defaults)) {
    if (name === 'panel') {
      continue;
    }
    const stored = value[name];
    if (stored === undefined) {
      continue;
    }
    if (Array.isArray(fallback)) {
      // `fields`: a flag per field, read past its end as visible.
      if (Array.isArray(stored) && stored.every((flag) => typeof flag === 'boolean')) {
        kept[name] = stored;
      }
    } else if (fallback === undefined) {
      // A setting with no default to compare against — the 3-D camera, which is
      // absent until the view has been framed. Checked on its own terms.
      const camera = readCamera(stored);
      if (camera !== undefined) {
        kept[name] = camera;
      }
    } else if (typeof stored === typeof fallback) {
      kept[name] = stored;
    }
  }
  return settingsOf(kept as unknown as PanelSettings, defaults);
}

/** Where the camera stood: three numbers, three numbers and a zoom, or nothing. */
function readCamera(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  const triple = (candidate: unknown): boolean =>
    Array.isArray(candidate) &&
    candidate.length === 3 &&
    candidate.every((part) => typeof part === 'number' && Number.isFinite(part));
  return triple(value.position) && triple(value.target) && typeof value.zoom === 'number'
    ? value
    : undefined;
}

/** A ratio that cannot squeeze either side away, whatever was stored. */
function clampRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, MINIMUM_RATIO), 1 - MINIMUM_RATIO)
    : 0.5;
}

/**
 * A counter that cannot mint a key already in use.
 *
 * Recomputed from the keys actually present rather than trusted, because a
 * stored counter that is too low hands out a duplicate — and a duplicate pane
 * key is the one thing this reader cannot repair.
 */
function countFrom(stored: unknown, keys: readonly string[]): number {
  const used = keys.map((key) => Number(/-(\d+)$/.exec(key)?.[1] ?? 0));
  const highest = used.length === 0 ? 0 : Math.max(...used);
  const claimed = typeof stored === 'number' && Number.isFinite(stored) ? Math.floor(stored) : 1;
  return Math.max(claimed, highest + 1, 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reading and writing the store itself.
 *
 * Both wrapped, because `localStorage` does not merely come back empty in a
 * private window or with site data blocked — the accessor itself throws. A
 * layout that cannot be saved is a small loss; an app that will not start
 * because of one is not.
 */
export function loadLibrary(): LayoutLibrary {
  try {
    return readLibrary(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_LIBRARY;
  }
}

export function saveLibrary(library: LayoutLibrary): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeLibrary(library));
  } catch {
    // Nothing to do and nothing worth saying: the session is unaffected.
  }
}
