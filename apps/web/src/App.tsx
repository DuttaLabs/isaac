import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { decodeZmx, exportZmx, importZmx } from '@isaac/zemax-io';
import { computeFirstOrder } from './lib/analysis.ts';
import { suppressNativeContextMenu, type MenuPoint } from './lib/context-menu.ts';
import { ContextMenu, type MenuItem } from './components/ContextMenu.tsx';
import {
  keysWithHandles,
  lensFileRecents,
  loadRecents,
  readHandle,
  recallHandle,
  rememberHandle,
  saveRecents,
  withRecent,
  type RecentFile,
} from './lib/recent-files.ts';
import { defaultSystem, emptySystem } from './lib/default-system.ts';
import { renameSystem } from './lib/edits.ts';
import {
  elementColorsBySurface,
  hiddenSurfaceIndices,
  surfaceColorsBySurface,
  systemAsTraced,
  type ElementStyles,
} from './lib/elements.ts';
import { Splitter } from './components/Splitter.tsx';
import { cssRect, tile } from './lib/tiling.ts';
import { saveTextToFile, suggestedFileName } from './lib/save-file.ts';
import { GLASS_CATALOG, GLASS_CATALOG_NAMES } from './lib/materials.ts';
import { TextCell } from './components/TextCell.tsx';
import { attempt, describeError } from './lib/result.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { BlankPanel, ErrorNote, type PanelChoice } from './components/Panel.tsx';
import { PANEL_TITLES } from './lib/panels.ts';
import {
  loadLibrary,
  saveLibrary,
  shownKey,
  withWorkspace,
  workspaceIn,
  type WindowId,
} from './lib/layout-storage.ts';
import {
  DEFAULT_LAYOUT_2D,
  DEFAULT_LAYOUT_3D,
  DEFAULT_RAY_FAN,
  DEFAULT_SPOT,
  DEFAULT_TEXT_EDITOR,
  settingsOf,
  type PanelSettings,
} from './lib/panel-settings.ts';
import {
  DEFAULT_SECONDARY_WORKSPACE,
  DEFAULT_WORKSPACE,
  closePane,
  resizeSplit,
  setPanePanel,
  setPaneSettings,
  splitPane,
  type LayoutNode,
  type Pane,
  type Workspace,
} from './lib/workspace.ts';
import { LayoutBar } from './components/LayoutBar.tsx';
import { SecondaryWindow } from './components/SecondaryWindow.tsx';
import {
  moveToOtherScreen,
  openSecondaryWindow,
  screenPlacementState,
  type ScreenPlacement,
  type SecondaryWindowHandle,
} from './lib/secondary-window.ts';
import { FirstOrderPanel } from './components/FirstOrderPanel.tsx';
import { FullScreenButton } from './components/FullScreenButton.tsx';
import { LensDataEditor } from './components/LensDataEditor.tsx';
import { Layout2DPanel } from './components/Layout2DPanel.tsx';
import { Layout3DPanel } from './components/Layout3DPanel.tsx';
import { RayFanPanel } from './components/RayFanPanel.tsx';
import { SourcePanel } from './components/SourcePanel.tsx';
import { SpotPanel } from './components/SpotPanel.tsx';
import { TextEditorPanel } from './components/TextEditorPanel.tsx';
import { languageOf } from './lib/text-documents.ts';

/**
 * The development tweak panel, and `lil-gui` behind it. `import.meta.env.DEV` is
 * a literal `false` in a production build, so the whole `lazy` arm is dead code
 * and the dynamic import goes with it — which is what keeps a devDependency out
 * of the shipped bundle. Verified by grepping the build output, not assumed.
 */
const TweakPanel = import.meta.env.DEV ? lazy(() => import('./dev/TweakPanel.tsx')) : undefined;

const HISTORY_LIMIT = 50;
/** Width of a divider. Wide enough to hit; the rule drawn in it is 2px. */
const SPLITTER_PX = 10;
/** The margin around the whole workspace, in pixels, so it does not scale. */
const WORKSPACE_INSET = 12;
/** How long after the last layout change the arrangement is written to storage. */
const LAYOUT_SAVE_MS = 400;
type Theme = 'system' | 'light' | 'dark';

interface Notice {
  kind: 'error' | 'info';
  text: string;
  /** Things the file said that the reader could not honor exactly. */
  warnings?: readonly string[];
  /**
   * Record types the reader skipped. These are annotation — notes, tolerancing,
   * display and analysis settings — not prescription, so they are shown folded
   * away: a long list is normal and says nothing about the imported design.
   */
  ignoredTokens?: readonly string[];
}

/**
 * How long each field is left up while cycling. Slow enough to look at, quick
 * enough that a six-field design comes round in under five seconds.
 */
const FIELD_CYCLE_MS = 750;

export function App() {
  const [history, setHistory] = useState(() => ({ stack: [defaultSystem()], index: 0 }));
  const [theme, setTheme] = useState<Theme>('dark');
  /**
   * The file this design lives in, once it has one — the name from the Open
   * dialog or the one typed into Save. A view setting, not part of the design:
   * where a lens is stored is not a fact about the lens, and it must never land
   * on the undo stack or be written into the file's own `NAME` record.
   *
   * It is a different thing from `system.name`, which is that `NAME` record: a
   * description ("A SIMPLE DOUBLET USING A CROWN AND A FLINT."), not a filename.
   * The app bar shows both because a file can be renamed without the lens being
   * renamed, and usually is.
   */
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  /**
   * The text of the file that was opened, kept so the text panel can show what
   * the file actually says.
   *
   * Not the same thing as exporting the system: a file carries thirty-odd record
   * types the reader does not interpret, and none of them survive the round trip
   * into the model. Holding the original is the only way to show them, and
   * putting the two side by side is the point of the panel.
   */
  const [fileText, setFileText] = useState<string | undefined>(undefined);
  /**
   * The lens files opened before, so one can be reopened without going and
   * finding it again. Shared with the text panel — it is one list of what Isaac
   * has had open, and a file read there is very often the file wanted here.
   *
   * Read once in a lazy initializer, since `localStorage` is synchronous and an
   * effect would render an empty menu and then fill it.
   */
  /**
   * Bumped when the design is **replaced** — a file opened, New, Reset — and
   * never when one is edited. The 3-D view frames a new subject afresh only if
   * the user has not set up a camera of their own, which is right for an edit
   * and wrong for a different lens entirely: the old camera's clipping planes
   * belong to the old system, and a new one can arrive behind them and simply
   * not be there. A new design is a new picture, so it gets a new view.
   */
  const [designSignal, setDesignSignal] = useState(0);
  const [recents, setRecents] = useState<RecentFile[]>(loadRecents);
  /** Where the recents menu is, or `undefined` while it is shut. */
  const [recentsAt, setRecentsAt] = useState<MenuPoint | undefined>(undefined);
  const recentsButton = useRef<HTMLButtonElement>(null);
  /**
   * The fallback for a browser with no `showOpenFilePicker`. Kept mounted and
   * hidden rather than created on demand: a click has to reach it inside the
   * user's own gesture, and an element added in that moment is not yet there.
   */
  const filePicker = useRef<HTMLInputElement>(null);
  /**
   * The recent entries that can actually reopen — the ones a handle was kept
   * for. Read whenever the list changes, so it is in hand *before* the menu is
   * drawn: resolving it on open would ghost half the entries a moment after
   * they appeared, which is worse than either state on its own.
   */
  const [reopenable, setReopenable] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * What the user has named and colored each element, keyed by the id of the
   * element's front surface. View state, like the field checkboxes and the
   * filename: a `.zmx` has nowhere to put a label or a color, so keeping these
   * on `OpticalSystem` would either be dropped silently on save or break the
   * round trip that says a file written and read back is the same system. The
   * key is a surface id rather than a row number so a name survives an insert
   * above it.
   */
  const [elementStyles, setElementStyles] = useState<ElementStyles>({});

  /**
   * Every arrangement Isaac knows: the named layouts, and which one each window
   * is pointed at. One piece of state rather than the several it grew from,
   * because a closed panel has to take its share of the space with it, and a
   * window has to be able to change which layout it is showing.
   *
   * Read from storage **once and synchronously**, in a lazy initializer rather
   * than an effect: `localStorage` is synchronous, so the layout is in hand
   * before the first paint, where an effect would render the default
   * arrangement and then snap to the stored one.
   *
   * A view setting like the field checkboxes, and for the same reason: an
   * arrangement someone likes is not a fact about the lens, so it must not land
   * on the undo stack or be written into a file.
   */
  const [library, setLibrary] = useState(loadLibrary);
  /**
   * The setter a pane's own controls are handed, naming the layout it is in —
   * which is what keeps a pane in the second window from rearranging the first
   * window's layout. It takes a `SetStateAction` because that is what every
   * workspace operation already expects to be given.
   *
   * **The arrangement on screen is derived from the library, never stored beside
   * it.** Each window was state of its own while a layout belonged to a window;
   * once either can be pointed at any layout there is nowhere for a second copy
   * to live without going stale. Both may name the *same* layout, and then they
   * mirror — one tree drawn twice, in two places.
   */
  const updateWorkspace =
    (key: string): Dispatch<SetStateAction<Workspace>> =>
    (action) =>
      setLibrary((current) => {
        const tree = workspaceIn(current, key, DEFAULT_WORKSPACE);
        const next = typeof action === 'function' ? action(tree) : action;
        return next === tree ? current : withWorkspace(current, key, next);
      });
  /** Development only: whether the tweak panel is showing. See `dev/tweaks.ts`. */
  const [showTweaks, setShowTweaks] = useState(false);

  /**
   * Which fields the layout draws. A view setting, not part of the design, so it
   * is kept here rather than on `OpticalSystem`: switching a field off to see
   * past it must not land on the undo stack or be written into a lens file.
   */
  const [fieldVisibility, setFieldVisibility] = useState<boolean[]>([]);
  /**
   * The selection to put back when field cycling stops, and the flag that it is
   * running. Cycling drives `fieldVisibility` itself so the checkboxes show
   * which field is up, which means the user's own selection has to be held
   * somewhere — losing it to a visual aid would be a poor trade.
   */
  const [cycleBase, setCycleBase] = useState<boolean[] | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>();
  /**
   * The second window itself. A view setting, living here rather than on
   * `OpticalSystem` for the same reason the field checkboxes do: where a panel is
   * shown is not part of the design, and opening one must not land on the undo
   * stack.
   */
  const [secondary, setSecondary] = useState<SecondaryWindowHandle | undefined>();
  /**
   * Writing the library back, a moment after the last change.
   *
   * Debounced because a divider drag calls `resizeSplit` on every pointer move,
   * and `localStorage.setItem` is synchronous — a write per frame would stall
   * the main thread during exactly the gesture that has to stay smooth. The
   * delay is short enough that any pause counts as finished.
   */
  useEffect(() => {
    const timer = setTimeout(() => saveLibrary(library), LAYOUT_SAVE_MS);
    return () => clearTimeout(timer);
  }, [library]);

  /**
   * Whether the browser will place a window on a chosen display. Asked once, up
   * front, because the answer decides whether opening the window can move it
   * too: only a granted permission works without a live user gesture, and the
   * gesture that opens the window is spent doing exactly that.
   */
  const [displayAccess, setDisplayAccess] = useState<ScreenPlacement>('unsupported');
  // Which surface the pointer or the keyboard is currently on in the table. The
  // editor and the layout are siblings, so the link between them lives here.
  const [highlightedSurface, setHighlightedSurface] = useState<number | undefined>(undefined);

  const system = history.stack[history.index]!;
  const canUndo = history.index > 0;
  const canRedo = history.index < history.stack.length - 1;

  const pushSystem = useCallback((next: OpticalSystem) => {
    setHistory((current) => {
      const stack = [...current.stack.slice(0, current.index + 1), next].slice(-HISTORY_LIMIT);
      return { stack, index: stack.length - 1 };
    });
  }, []);

  /**
   * Puts a whole design on screen — the New button's blank one, the Reset
   * button's doublet — and clears the view state that only made sense against
   * the old one: the per-field Display flags no longer line up with a different
   * field list, a cycle running through them has nothing left to cycle, and a
   * notice about the last file is not about this design. The system itself goes
   * through the undo stack like any other edit, so starting over is undoable.
   */
  const startFrom = useCallback(
    (next: OpticalSystem) => {
      pushSystem(next);
      setDesignSignal((n) => n + 1);
      setFieldVisibility([]);
      setCycleBase(undefined);
      setNotice(undefined);
      // Neither the blank system nor the sample doublet came from a file.
      setFileName(undefined);
      setFileText(undefined);
      // Element styles are keyed by surface id, and ids are only unique within
      // one system — two files both name their first surface `surf-1`. Carrying
      // them over would paint a new design in the last one's colors.
      setElementStyles({});
    },
    [pushSystem],
  );

  /**
   * Takes the panels back and forgets the window. Called both when the user
   * closes it from the app bar and when they close the window itself, so it
   * does not close anything — by the second route it has already gone.
   */
  const forgetSecondary = useCallback(() => setSecondary(undefined), []);

  /**
   * Opens the second window, reporting a blocked pop-up rather than leaving a
   * button that appears to do nothing. Returns the handle so the click that
   * asked for it can go on to use it: the state set here is not readable until
   * the next render.
   */
  const openSecondary = (): SecondaryWindowHandle | undefined => {
    try {
      const handle = openSecondaryWindow(`Isaac — ${system.name}`);
      setSecondary(handle);
      // Only when it has already been allowed. Asking here cannot work: the
      // prompt needs a live user gesture and `window.open` has just spent it.
      if (displayAccess === 'granted') {
        void moveToOtherScreen(handle.window).catch((error: unknown) =>
          setNotice({ kind: 'error', text: describeError(error) }),
        );
      }
      return handle;
    } catch (error) {
      setNotice({ kind: 'error', text: describeError(error) });
      return undefined;
    }
  };

  /** Asks for the display permission on its own click, then moves the window. */
  const moveSecondaryAcross = (): void => {
    if (secondary === undefined) {
      return;
    }
    moveToOtherScreen(secondary.window).then(
      () => setDisplayAccess('granted'),
      (error: unknown) => {
        void screenPlacementState().then(setDisplayAccess);
        setNotice({ kind: 'error', text: describeError(error) });
      },
    );
  };

  useEffect(() => {
    void screenPlacementState().then(setDisplayAccess);
  }, []);

  // Right-click belongs to the panel under the pointer. Turned off for the whole
  // document rather than panel by panel, so a panel that has no menu of its own
  // yet does nothing rather than falling back to Back / Reload / View source —
  // which is not an answer to any question this app can be asked.
  useEffect(() => suppressNativeContextMenu(document), []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  // One color per surface of an element, so a view can look one up by the index
  // it already has on a body or a solid. A cemented pair is two bodies inside
  // one element; keying by surface is what makes both halves come out alike.
  const elementColors = useMemo(
    () => elementColorsBySurface(system, elementStyles),
    [system, elementStyles],
  );
  // The object and image planes and any colored mirror: things drawn as a single
  // surface rather than as a body, which is why they are kept in their own map —
  // see `surfaceColorsBySurface`.
  const surfaceColors = useMemo(
    () => surfaceColorsBySurface(system, elementStyles),
    [system, elementStyles],
  );

  /**
   * The system as it is **traced**, which is the design with every hidden element
   * taken out of the light.
   *
   * Two systems, and the split is the point. The lens grid and the source panel
   * read the *design*: hiding an element must not make its rows disappear, since
   * the whole use of the switch is to compare with it and without. Everything
   * that draws or traces reads this one, so a hidden lens is absent from the
   * picture, from the fans, and from the first-order numbers alike — which is
   * what "ignore its effect" has to mean if the comparison is to be worth
   * anything.
   *
   * Derived rather than stored, so switching an element back on restores exactly
   * what was there and nothing lands on the undo stack.
   */
  const tracedSystem = useMemo(
    () => systemAsTraced(system, elementStyles),
    [system, elementStyles],
  );
  /**
   * Which surfaces the drawings leave out: the faces of every element switched
   * off. Taken from the *design*, because the traced system can no longer tell a
   * hidden lens's faces from any other pair of air-to-air planes.
   */
  const hiddenSurfaces = useMemo(
    () => hiddenSurfaceIndices(system, elementStyles),
    [system, elementStyles],
  );
  const firstOrder = useMemo(() => computeFirstOrder(tracedSystem), [tracedSystem]);
  const pupilRadius = firstOrder.ok ? firstOrder.value.entrancePupilRadius : 10;

  // Padded rather than required to match: a system arriving from a file, an
  // undo, or the reset button brings its own field list, and anything the flags
  // do not cover is drawn. Removing a field keeps the flags in step at the row
  // that knows which one went; this only has to be safe, not clever.
  const fieldCount = system.fields.length;

  /**
   * Shows one visible field at a time, in turn, so a reader can tell which
   * bundle is which when several cross. Only the fields that were checked when
   * cycling started take part — it is a way of looking at a chosen set, not a
   * way of choosing one.
   */
  useEffect(() => {
    if (cycleBase === undefined) {
      return;
    }
    // A design changing underfoot — a file loaded, an undo, a field added —
    // invalidates the saved selection, so cycling stops rather than restoring
    // flags that no longer line up with the fields.
    if (cycleBase.length !== fieldCount) {
      setCycleBase(undefined);
      return;
    }
    const taking = cycleBase.flatMap((shown, index) => (shown ? [index] : []));
    if (taking.length < 2) {
      setCycleBase(undefined);
      return;
    }

    let step = 0;
    const show = (): void => {
      const current = taking[step % taking.length]!;
      setFieldVisibility(cycleBase.map((_, index) => index === current));
    };
    show();
    const timer = setInterval(() => {
      step += 1;
      show();
    }, FIELD_CYCLE_MS);
    return () => clearInterval(timer);
  }, [cycleBase, fieldCount]);

  /** Starts cycling from the current selection, or stops and puts it back. */
  const toggleFieldCycling = (): void => {
    if (cycleBase !== undefined) {
      setFieldVisibility(cycleBase);
      setCycleBase(undefined);
      return;
    }
    setCycleBase(system.fields.map((_, index) => fieldVisibility[index] ?? true));
  };

  /**
   * A visibility change the user made. It ends cycling without restoring the
   * saved selection: they are looking at the flags cycling left and have just
   * edited those, so those are the ones they mean.
   */
  const changeFieldVisibility = (next: boolean[]): void => {
    setCycleBase(undefined);
    setFieldVisibility(next);
  };

  const loadFile = async (file: File, handle?: FileSystemFileHandle): Promise<void> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = importZmx(bytes, { resolveMaterial: GLASS_CATALOG.resolver() });
      pushSystem(result.system);
      setDesignSignal((n) => n + 1);
      setFileName(file.name);
      // Decoded by the reader's own routine, so a UTF-16 file reads as text
      // rather than as every other character being a null.
      setFileText(decodeZmx(bytes));
      // A different design brings different elements; see `startFrom`.
      setElementStyles({});
      // A file brings its own field list, so flags set against the previous
      // design mean nothing against this one. Everything starts visible.
      setFieldVisibility([]);
      setCycleBase(undefined);
      // Recorded only once the import has succeeded. A file that could not be
      // read is not one to offer reopening, and putting it at the top of the
      // list would make the next session's first click a repeat of this error.
      const next = withRecent(recents, file.name, Date.now());
      setRecents(next);
      saveRecents(next);
      if (handle !== undefined) {
        void rememberHandle(`file:${file.name}`, handle);
      }

      const { system: loaded, warnings, ignoredTokens } = result;
      setNotice({
        kind: 'info',
        text:
          `Loaded ${file.name} — ${loaded.surfaces.length} surfaces, ${loaded.fields.length} fields, ` +
          `${loaded.wavelengthsNm.length} wavelengths.`,
        warnings,
        ignoredTokens,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: `${file.name}: ${describeError(error)}` });
    }
  };

  /**
   * The file dialog where the browser has one, and a plain file input where it
   * does not. Only the first hands back a **handle**, which is what lets a
   * recent entry reopen a file rather than merely name it — so the fallback path
   * still opens the lens, and loses only the shortcut.
   *
   * A plain function, like `loadFile` and `reopenRecent` beside it. Nothing
   * depends on its identity, and memoizing it captured the first render's
   * `loadFile` — and with it an empty `recents`, so every file opened through
   * the picker reset the list to itself. The fallback input never showed it,
   * because its handler is written inline and is fresh every render.
   */
  const pickLensFile = async (): Promise<void> => {
    const withPicker = window as unknown as {
      showOpenFilePicker?: (options?: object) => Promise<FileSystemFileHandle[]>;
    };
    if (withPicker.showOpenFilePicker === undefined) {
      filePicker.current?.click();
      return;
    }
    try {
      const [handle] = await withPicker.showOpenFilePicker.call(window, {
        multiple: false,
        types: [{ description: 'Zemax lens file', accept: { 'text/plain': ['.zmx', '.ZMX'] } }],
      });
      if (handle === undefined) {
        return;
      }
      await loadFile(await handle.getFile(), handle);
    } catch (problem) {
      // Closing the dialog is not failing, and a red notice in front of someone
      // who simply changed their mind is worse than no notice at all.
      if (problem instanceof DOMException && problem.name === 'AbortError') {
        return;
      }
      filePicker.current?.click();
    }
  };

  /**
   * Opens a file from the recent list. A handle stored yesterday needs the
   * user's word again today, and either half can be gone — the browser may
   * never have kept a handle, or the file may have moved since. Both are said in
   * the notice, because a menu entry that does nothing is the worst outcome.
   */
  const lensFiles = useMemo(() => lensFileRecents(recents), [recents]);

  useEffect(() => {
    let current = true;
    void keysWithHandles().then((keys) => {
      if (current) {
        setReopenable(keys);
      }
    });
    return () => {
      current = false;
    };
  }, [recents]);

  const reopenRecent = async (recent: RecentFile): Promise<void> => {
    const handle = await recallHandle(recent.key);
    if (handle === undefined) {
      setNotice({
        kind: 'error',
        text: `${recent.name} was opened before, but this browser did not keep a handle for it. Open it again to add one.`,
      });
      return;
    }
    const file = await readHandle(handle);
    if (file === undefined) {
      setNotice({
        kind: 'error',
        text: `${recent.name} could not be read — permission was refused, or it has moved.`,
      });
      return;
    }
    await loadFile(file, handle);
  };

  /**
   * Open, then the files opened before it.
   *
   * Filtered to `.zmx`, because this loads a *design*: the shared list also
   * holds whatever the text panel has read, and offering a `.txt` here would
   * promise a lens that is not there and fail after the click.
   *
   * An empty list is a **ghosted line saying so**, not an absent one — the same
   * rule the lens grid's menu follows. A menu that is one item long on the first
   * run and two on the second teaches nobody what the button does, and "no
   * recent files yet" is the answer to the question that was just asked.
   */
  const recentFileMenu: MenuItem[] = [
    {
      key: 'open',
      label: 'Open .zmx…',
      hint: 'Choose a lens file to load',
      onSelect: () => void pickLensFile(),
    },
    ...(lensFiles.length === 0
      ? [
          {
            key: 'none',
            label: 'No recent files yet',
            hint: 'Files you open appear here',
            disabled: true,
            startsGroup: true,
            onSelect: () => {},
          },
        ]
      : lensFiles.map((recent, index) => ({
          key: recent.key,
          label: recent.name,
          // An entry with no handle is a *name*, not a shortcut: the browser
          // that opened it never kept one, so there is nothing to reopen from.
          // Ghosted with the reason rather than left looking live, which turns
          // the click into an error message and the menu into a guess.
          disabled: !reopenable.has(recent.key),
          hint: reopenable.has(recent.key)
            ? `Opened ${new Date(recent.openedAt).toLocaleString()}`
            : `Opened ${new Date(recent.openedAt).toLocaleString()}, but this browser kept no handle for it — open it again to add one`,
          startsGroup: index === 0,
          onSelect: () => void reopenRecent(recent),
        }))),
  ];

  /**
   * Writes the design out as .zmx. What is written is what Isaac models — a file
   * that came *in* carried records this reader does not interpret, and they are
   * not on `OpticalSystem` to write back — so the notice says so rather than
   * letting an export pass for a copy of the original file.
   */
  const saveFile = async (): Promise<void> => {
    try {
      const { text, warnings } = exportZmx(system, { glassCatalogs: GLASS_CATALOG_NAMES });
      const outcome = await saveTextToFile(text, {
        // The name it already has, so saving twice does not quietly propose a
        // different file the second time. Only a design with no file yet falls
        // back to a name derived from the lens.
        suggestedName: fileName ?? suggestedFileName(system.name, '.zmx'),
        description: 'Zemax lens file',
        accept: { 'text/plain': ['.zmx'] },
      });
      if (outcome.kind === 'canceled') {
        return; // the user closed the dialog; nothing happened and nothing is wrong
      }
      // Whatever the user typed in the dialog is now the file this design lives
      // in — including a Save As under a new name, which is how a file gets
      // renamed and why the picker's answer is taken rather than the suggestion.
      setFileName(outcome.name);
      setNotice({
        kind: 'info',
        text:
          outcome.kind === 'saved'
            ? `Saved ${outcome.name} — ${system.surfaces.length} surfaces.`
            : `This browser has no save dialog, so ${outcome.name} went to your downloads.`,
        warnings: [
          'The file holds what Isaac models. Anything it does not read — notes, tolerancing, multi-configuration — is not written back.',
          ...warnings,
        ],
      });
    } catch (error) {
      setNotice({ kind: 'error', text: `Could not save: ${describeError(error)}` });
    }
  };

  /**
   * Renames the lens. This is the `NAME` record written into the file, not the
   * file's own name — the two sit side by side in the app bar because they are
   * different things and a rename of one is not a rename of the other.
   */
  const renameLens = (next: string): void => {
    const renamed = renameSystem(system, next);
    if (renamed.ok) {
      pushSystem(renamed.value);
    } else {
      // The field snaps back to the stored name on its own, so the notice only
      // has to say why.
      setNotice({ kind: 'error', text: renamed.error });
    }
  };

  /**
   * Records one change to an element's appearance. A `color` of `undefined`
   * hands it back to the theme, which is different from never having chosen —
   * so the key is dropped rather than left holding an empty style.
   */
  const setElementStyle = (
    key: string,
    change: { label?: string; color?: string | undefined; hidden?: boolean },
  ): void => {
    setElementStyles((current) => {
      const entry: { label?: string; color?: string; hidden?: boolean } = {
        ...current[key],
        ...change,
      };
      if (entry.color === undefined) {
        delete entry.color;
      }
      if (entry.label === undefined || entry.label.trim() === '') {
        delete entry.label;
      }
      // `false` is the default, so an element switched back on carries nothing —
      // which is what lets the whole entry be dropped when it holds no choices.
      if (entry.hidden !== true) {
        delete entry.hidden;
      }
      const next = { ...current, [key]: entry };
      if (Object.keys(entry).length === 0) {
        delete next[key];
      }
      return next;
    });
  };

  const fieldLabel = (index: number): string => {
    const field = system.fields[index];
    if (!field) {
      return 'on axis';
    }
    return field.angleDeg !== undefined
      ? `${field.angleDeg}°`
      : `h = ${field.objectHeight ?? 0} ${system.units}`;
  };

  /**
   * The panel a slot has been turned over to.
   *
   * Every panel is written once here and rendered wherever its slot happens to
   * be, which is the whole of what makes the header dropdown possible: the
   * arrangement is data, so a panel is no longer tied to the one place in the
   * JSX it was written.
   */
  /**
   * Controls the two layout panels share.
   *
   * Both set what is *traced* rather than how it is drawn, so both views read
   * them and every copy of either view moves together — which is the rule the
   * whole arrangement rests on. Anything that must differ between two panels on
   * screen is a difference of panel, and that is exactly why the 2-D/3-D switch
   * is gone: it is now the panel chooser.
   */

  /** Writes one pane's settings back into whichever window's tree it is in. */
  const writeSettings = (
    found: Pane,
    update: Dispatch<SetStateAction<Workspace>>,
    next: PanelSettings,
  ): void => update((current) => setPaneSettings(current, found.key, next));

  /**
   * The panel a pane has been turned over to.
   *
   * Every panel is written once here and rendered wherever its panes happen to
   * be — pane*s*, because the same panel may be open several times, and the two
   * kinds of panel behave differently when it is:
   *
   * - An **input** panel — the source object, the lens grid — takes no settings
   *   and reads `system` directly, so every copy shows the same thing because
   *   every copy is the same JSX over the same immutable model. There is nothing
   *   keeping them in step because there is nothing to keep in step.
   * - An **output** panel takes its settings from its own pane and writes them
   *   back there, so two copies are independent: one Layout 2D can be turned to
   *   X–Z while another shows Y–Z, which is the whole reason to open a second.
   *
   * That is why `update` is threaded down here — a pane in the second window
   * must write to the second window's tree.
   */
  const renderPanel = (
    found: Pane,
    choice: PanelChoice,
    update: Dispatch<SetStateAction<Workspace>>,
  ): ReactNode => {
    switch (found.panel) {
      case 'source':
        return (
          <ErrorBoundary label="Source object">
            <SourcePanel
              system={system}
              onChange={pushSystem}
              fieldVisibility={fieldVisibility}
              onFieldVisibilityChange={changeFieldVisibility}
              cyclingFields={cycleBase !== undefined}
              onToggleFieldCycling={toggleFieldCycling}
              choice={choice}
            />
          </ErrorBoundary>
        );
      case 'system':
        return (
          <ErrorBoundary label="Optical system">
            <LensDataEditor
              system={system}
              onChange={pushSystem}
              onHighlight={setHighlightedSurface}
              highlightedSurface={highlightedSurface}
              elementStyles={elementStyles}
              onElementStyle={setElementStyle}
              choice={choice}
            />
          </ErrorBoundary>
        );
      case 'firstOrder':
        return (
          <ErrorBoundary label="First order">
            <FirstOrderPanel system={tracedSystem} firstOrder={firstOrder} choice={choice} />
          </ErrorBoundary>
        );
      case 'layout2d':
        return (
          <Layout2DPanel
            system={tracedSystem}
            settings={settingsOf(found.settings, DEFAULT_LAYOUT_2D)}
            onSettings={(next) => writeSettings(found, update, next)}
            choice={choice}
            sourceFields={fieldVisibility}
            hiddenSurfaces={hiddenSurfaces}
            firstOrder={firstOrder}
            elementColors={elementColors}
            surfaceColors={surfaceColors}
            highlightedSurface={highlightedSurface}
          />
        );
      case 'layout3d':
        return (
          <Layout3DPanel
            designSignal={designSignal}
            system={tracedSystem}
            settings={settingsOf(found.settings, DEFAULT_LAYOUT_3D)}
            onSettings={(next) => writeSettings(found, update, next)}
            choice={choice}
            sourceFields={fieldVisibility}
            hiddenSurfaces={hiddenSurfaces}
            firstOrder={firstOrder}
            elementColors={elementColors}
            surfaceColors={surfaceColors}
            highlightedSurface={highlightedSurface}
          />
        );
      case 'rayFan':
        return (
          <RayFanPanel
            system={tracedSystem}
            settings={settingsOf(found.settings, DEFAULT_RAY_FAN)}
            onSettings={(next) => writeSettings(found, update, next)}
            choice={choice}
          />
        );
      case 'spot':
        return (
          <SpotPanel
            system={tracedSystem}
            settings={settingsOf(found.settings, DEFAULT_SPOT)}
            onSettings={(next) => writeSettings(found, update, next)}
            choice={choice}
          />
        );
      case 'textEditor':
        return (
          <TextEditorPanel
            settings={settingsOf(found.settings, DEFAULT_TEXT_EDITOR)}
            onSettings={(next) => writeSettings(found, update, next)}
            supplied={suppliedDocuments}
            choice={choice}
          />
        );
    }
  };

  /**
   * What every text panel is handed: the file this design came from, and the
   * file it would be saved as.
   *
   * Two documents rather than one because they are two different things, and the
   * difference is the interesting part. The first is what the file says,
   * including the thirty-odd record types Isaac does not interpret; the second
   * is what Isaac models, rebuilt from the system on every change so it is
   * always what Save would write. A design built here has only the second.
   *
   * The export is attempted rather than assumed: a system with mixed field types
   * is refused by the writer, and a panel showing the reason beats one showing
   * nothing.
   */
  const suppliedDocuments = useMemo(() => {
    const documents = [];
    if (fileName !== undefined && fileText !== undefined) {
      documents.push({
        key: 'file',
        name: fileName,
        text: fileText,
        readOnly: true,
        language: languageOf(fileName),
      });
    }
    const written = attempt(() => exportZmx(system, { glassCatalogs: GLASS_CATALOG_NAMES }).text);
    documents.push({
      key: 'export',
      name: 'Current design.zmx',
      text: written.ok ? written.value : `This design cannot be written yet:\n\n${written.error}`,
      readOnly: true,
      language: 'zmx' as const,
      derived: true,
    });
    return documents;
  }, [fileName, fileText, system]);

  /**
   * The three things that can be done to a pane, as opposed to its panel.
   *
   * `update` is the setter for whichever window's arrangement this pane is in.
   * There are two trees now, and every operation has to name one — passing the
   * setter down is what keeps a pane in the second window from editing the
   * first window's layout.
   */
  const choiceOf = (
    found: Pane,
    update: Dispatch<SetStateAction<Workspace>>,
    onlyPane: boolean,
  ): PanelChoice => ({
    id: found.panel,
    onChange: (next) => update((current) => setPanePanel(current, found.key, next)),
    onSplit: (direction) => update((current) => splitPane(current, found.key, direction)),
    onClose: () => update((current) => closePane(current, found.key)),
    // Closing the last pane blanks it; closing one already blank would do
    // nothing at all, and a control that does nothing is a puzzle.
    canClose: !(onlyPane && found.panel === undefined),
  });

  /**
   * One node of the layout tree: a panel, or a split of two smaller nodes.
   *
   * Recursive, and that is the whole of the layout — there is no column, no row,
   * no level. A split is a three-track grid: a child, a divider, the other
   * child. The divider is a track of its own rather than a border on a panel, so
   * it has a width to grab that does not depend on either neighbour.
   *
   * Everything is keyed by the node's own key, so splitting or closing moves the
   * surviving DOM rather than rebuilding the branch — a panel that keeps its key
   * keeps its scroll position and, in the 3-D view, its camera.
   */
  /**
   * The whole workspace, as a flat list of absolutely positioned boxes.
   *
   * **Flat is the point.** Drawn as nested boxes, a pane's position in the React
   * tree was its depth in the layout tree — and closing a pane moves its sibling
   * up a level, which React answers by throwing the panel away and building a new
   * one. Every panel rebuilt that way came back blank: the lens table at the top
   * of its scroll, the 2-D view refitted, the 3-D camera back at its default.
   * Here every pane is a direct child of the workspace however the tree is
   * rearranged above it, so a pane that survives an operation is *moved*, never
   * rebuilt — and because splitting and closing preserve the order of the
   * survivors, React does not even have to move it.
   *
   * `lib/tiling.ts` does the arithmetic; this only turns rectangles into boxes.
   */
  const renderWorkspace = (which: WindowId): ReactNode => {
    const key = shownKey(library, which);
    const tree = workspaceIn(
      library,
      key,
      which === 'main' ? DEFAULT_WORKSPACE : DEFAULT_SECONDARY_WORKSPACE,
    );
    const update = updateWorkspace(key);
    const { panes, splitters } = tile(tree.root, SPLITTER_PX, WORKSPACE_INSET);
    const onlyPane = tree.root.kind === 'pane';
    return (
      <>
        <LayoutBar
          library={library}
          which={which}
          mirrored={secondary !== undefined && library.main === library.secondary}
          onLibrary={setLibrary}
        />
        <div className="workspace">
          {panes.map(({ pane, rect }) => {
            const choice = choiceOf(pane, update, onlyPane);
            return (
              <div key={pane.key} className="pane" style={cssRect(rect)}>
                {pane.panel === undefined ? (
                  <BlankPanel choice={choice} />
                ) : (
                  renderPanel(pane, choice, update)
                )}
              </div>
            );
          })}
          {splitters.map((divider) => (
            <Splitter
              key={divider.key}
              style={cssRect(divider.rect)}
              // The divider runs across the direction it moves in, which is the
              // easy thing to get backwards: side-by-side panels are parted by an
              // upright bar, and `aria-orientation` names the bar.
              orientation={divider.direction === 'row' ? 'vertical' : 'horizontal'}
              label={`Resize ${nodeName(divider.first)}`}
              valueNow={divider.ratio}
              span={divider.span}
              onResize={(delta) => update((current) => resizeSplit(current, divider.key, delta))}
            />
          ))}
        </div>
      </>
    );
  };

  return (
    <div className="app">
      <header className="app-bar">
        <h1 className="app-title">Isaac</h1>
        {fileName === undefined ? null : <span className="app-file">{fileName}</span>}
        <span className="app-lens-name">
          <TextCell
            value={system.name}
            ariaLabel="Lens name"
            title="The lens's own name, written into the file as its NAME record. Not the filename."
            onCommit={renameLens}
          />
        </span>

        <div className="app-bar-spacer" />

        <button onClick={() => startFrom(emptySystem())} title="Start an empty system">
          New
        </button>
        <button onClick={() => void saveFile()} title="Save this system as a .zmx file">
          Save
        </button>

        {/* One control where there were two things: the browser's own file
            input, which spends 190px on the words "No file chosen", and no way
            back to a file already opened. Opening is the first item rather than
            a button of its own — a menu reads down the page, and Open Recent
            under Open is where every editor puts it. */}
        <button
          ref={recentsButton}
          onClick={() => {
            const box = recentsButton.current?.getBoundingClientRect();
            setRecentsAt(box === undefined ? { x: 0, y: 0 } : { x: box.left, y: box.bottom + 2 });
          }}
          aria-haspopup="menu"
          aria-expanded={recentsAt !== undefined}
          title="Open a .zmx file, or one opened before"
        >
          Recent files
        </button>
        <input
          ref={filePicker}
          type="file"
          accept=".zmx,.ZMX"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void loadFile(file);
            }
            event.target.value = '';
          }}
        />

        <button
          onClick={() => setHistory((h) => ({ ...h, index: h.index - 1 }))}
          disabled={!canUndo}
        >
          Undo
        </button>
        <button
          onClick={() => setHistory((h) => ({ ...h, index: h.index + 1 }))}
          disabled={!canRedo}
        >
          Redo
        </button>
        <button onClick={() => startFrom(defaultSystem())} title="Go back to the sample doublet">
          Reset
        </button>
        <button
          onClick={() =>
            setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')
          }
          title="Cycle theme"
        >
          Theme: {theme}
        </button>
        {TweakPanel ? (
          <button
            onClick={() => setShowTweaks((showing) => !showing)}
            aria-pressed={showTweaks}
            title="Development only: live knobs for values that have to be looked at"
          >
            Tweaks
          </button>
        ) : null}
        {secondary && (displayAccess === 'prompt' || displayAccess === 'granted') ? (
          <button
            onClick={moveSecondaryAcross}
            title={
              displayAccess === 'granted'
                ? 'Move the second window to the other display'
                : 'Ask Chrome where your displays are, then move the second window to the other one'
            }
          >
            Move to other display
          </button>
        ) : null}
        <button
          onClick={() => {
            if (secondary) {
              secondary.window.close();
              forgetSecondary();
            } else {
              openSecondary();
            }
          }}
          aria-pressed={secondary !== undefined}
          title={
            secondary
              ? 'Close the second window. Its layout is kept for the next time.'
              : 'Open a second window, with its own layout, to drag onto another display'
          }
        >
          <span className="label-swap">
            <span className={secondary ? 'label-hidden' : undefined}>Second window</span>
            <span className={secondary ? undefined : 'label-hidden'}>Close 2nd window</span>
          </span>
        </button>
        <FullScreenButton onError={(text) => setNotice({ kind: 'error', text })} />
      </header>

      {recentsAt ? (
        <ContextMenu
          at={recentsAt}
          heading="Open"
          items={recentFileMenu}
          onClose={() => setRecentsAt(undefined)}
        />
      ) : null}

      {notice ? (
        <div style={{ padding: '10px 12px 0' }}>
          {notice.kind === 'error' ? (
            <ErrorNote message={notice.text} />
          ) : (
            <div className="hint">
              <p style={{ margin: 0 }}>
                {notice.text}{' '}
                <button className="subtle" onClick={() => setNotice(undefined)}>
                  dismiss
                </button>
              </p>
              {notice.warnings && notice.warnings.length > 0 ? (
                <ul className="notice-warnings">
                  {notice.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              {notice.ignoredTokens && notice.ignoredTokens.length > 0 ? (
                <details className="notice-details">
                  <summary>
                    {notice.ignoredTokens.length} record types outside the optical prescription were
                    not imported
                  </summary>
                  <p style={{ margin: '4px 0 0' }}>{notice.ignoredTokens.join(', ')}</p>
                </details>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {renderWorkspace('main')}

      {secondary ? (
        <SecondaryWindow
          handle={secondary}
          title={`Isaac — ${system.name}`}
          onClose={forgetSecondary}
        >
          {renderWorkspace('secondary')}
        </SecondaryWindow>
      ) : null}

      {TweakPanel ? (
        <Suspense fallback={null}>
          <TweakPanel open={showTweaks} />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * Gathers the first-order overlay from the two solves that feed it.
 *
 * The pupils are drawn at the radius the *beam* fills, not at the radius the
 * stop image reports. Those agree in a design whose stop is sized to its
 * aperture, and differ when it is not — and where they differ, the beam is the
 * honest one to draw, because otherwise the marginal ray sits in the middle of
 * the pupil it is supposed to define. The exit pupil is scaled by the same
 * fraction, since it is the image of the same aperture.
 */
/**
 * What to call a node in a divider's label.
 *
 * A divider parts two *subtrees*, not two panels, so naming it after one panel
 * would be a lie the moment either side is split again. A leaf is named; a
 * branch says how many panels are on that side of the line.
 */
function nodeName(node: LayoutNode): string {
  if (node.kind === 'pane') {
    return node.panel === undefined ? 'the empty pane' : `the ${PANEL_TITLES[node.panel]} panel`;
  }
  let leaves = 0;
  const count = (child: LayoutNode): void => {
    if (child.kind === 'pane') {
      leaves += 1;
      return;
    }
    count(child.first);
    count(child.second);
  };
  count(node);
  return `these ${leaves} panels`;
}
