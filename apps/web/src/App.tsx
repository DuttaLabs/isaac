import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { exportZmx, importZmx } from '@isaac/zemax-io';
import {
  computeFirstOrder,
  computeFirstOrderRays,
  computeLayoutTraces,
  computeRayFan,
  computeSpot,
  computeVolumeTraces,
  allFieldIndices,
  type FirstOrder,
  type FirstOrderRays,
} from './lib/analysis.ts';
import { suppressNativeContextMenu } from './lib/context-menu.ts';
import { defaultSystem, emptySystem } from './lib/default-system.ts';
import { renameSystem } from './lib/edits.ts';
import {
  elementColorsBySurface,
  surfaceColorsBySurface,
  type ElementStyles,
} from './lib/elements.ts';
import { Splitter } from './components/Splitter.tsx';
import { saveTextToFile, suggestedFileName } from './lib/save-file.ts';
import { GLASS_CATALOG, GLASS_CATALOG_NAMES } from './lib/materials.ts';
import { TextCell } from './components/TextCell.tsx';
import { formatMicrons } from './lib/format.ts';
import { describeError, type Result } from './lib/result.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { BlankPanel, ErrorNote, Panel, type PanelChoice } from './components/Panel.tsx';
import { PANEL_TITLES, type PanelId } from './lib/panels.ts';
import {
  DEFAULT_SECONDARY_WORKSPACE,
  DEFAULT_WORKSPACE,
  closePane,
  panelsOnScreen,
  panesInOrder,
  resizeSplit,
  setPanePanel,
  splitPane,
  type LayoutNode,
  type Pane,
  type Workspace,
} from './lib/workspace.ts';
import { SecondaryWindow } from './components/SecondaryWindow.tsx';
import { VIEW_PLANES, VIEW_PLANE_IDS, type ViewPlaneId } from './lib/view-plane.ts';
import {
  moveToOtherScreen,
  openSecondaryWindow,
  screenPlacementState,
  type ScreenPlacement,
  type SecondaryWindowHandle,
} from './lib/secondary-window.ts';
import { FirstOrderPanel } from './components/FirstOrderPanel.tsx';
import { FullScreenButton } from './components/FullScreenButton.tsx';
import { LayoutView, type FirstOrderOverlay } from './components/LayoutView.tsx';
import { FirstOrderLegend } from './components/FirstOrderLegend.tsx';
import { LensDataEditor } from './components/LensDataEditor.tsx';
import { RayFanPlot } from './components/RayFanPlot.tsx';
import { SourcePanel } from './components/SourcePanel.tsx';
import { SpotDiagram } from './components/SpotDiagram.tsx';
import { WavelengthLegend } from './components/WavelengthLegend.tsx';
import { FieldLegend } from './components/FieldLegend.tsx';

// Three.js and its React bindings are most of the bundle, and a session that
// never opens the 3-D view should never download them. Loaded on first use.
const Layout3DView = lazy(() =>
  import('./components/Layout3DView.tsx').then((module) => ({ default: module.Layout3DView })),
);

/**
 * The development tweak panel, and `lil-gui` behind it. `import.meta.env.DEV` is
 * a literal `false` in a production build, so the whole `lazy` arm is dead code
 * and the dynamic import goes with it — which is what keeps a devDependency out
 * of the shipped bundle. Verified by grepping the build output, not assumed.
 */
const TweakPanel = import.meta.env.DEV ? lazy(() => import('./dev/TweakPanel.tsx')) : undefined;

const HISTORY_LIMIT = 50;
/** Width of a divider track. Wide enough to hit; the rule drawn in it is 2px. */
const SPLITTER_PX = 10;
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

/**
 * Grid density from the rays-per-fan control, so one number drives both: a grid
 * of n across the pupil is the same sampling as a fan of n. Floored so a
 * three-ray fan still fills a picture, capped because a grid is n² rays.
 */
function gridAcrossPupil(raysPerFan: number): number {
  return Math.max(3, Math.min(raysPerFan, 15));
}

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
   * The whole arrangement: which panels are open, where, and how big.
   *
   * Sizes are `fr` weights rather than pixels, because the page does not scroll
   * — the workspace is exactly the height of the window, so a divider moves
   * space from one panel to its neighbour rather than making the page longer,
   * and the proportions survive the window being resized.
   *
   * One piece of state rather than the four it grew from, because opening and
   * closing panels means the sizes and the panels can no longer be separate
   * lists kept in step by hand: a closed panel has to take its weight with it.
   *
   * A view setting like the field checkboxes, and for the same reason: an
   * arrangement someone likes is not a fact about the lens, so it must not land
   * on the undo stack or be written into a file.
   */
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);
  /** Development only: whether the tweak panel is showing. See `dev/tweaks.ts`. */
  const [showTweaks, setShowTweaks] = useState(false);

  const [fieldIndex, setFieldIndex] = useState(0);
  const [raysPerFan, setRaysPerFan] = useState(9);
  const [showFirstOrder, setShowFirstOrder] = useState(false);
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
  const [allWavelengths, setAllWavelengths] = useState(false);
  /**
   * Which plane the 2-D view is drawn in. A view setting like the rest of them:
   * turning a design round to look at it from the side is not an edit, so it
   * never reaches `OpticalSystem` or the undo stack.
   */
  const [planeId, setPlaneId] = useState<ViewPlaneId>('YZ');
  /**
   * Bumped by each view's reset button. One counter per view rather than one
   * shared: the two layouts can now be on screen together, and re-fitting the
   * cross-section must not throw away the camera angle set up beside it.
   */
  const [reset2d, setReset2d] = useState(0);
  const [reset3d, setReset3d] = useState(0);
  const [notice, setNotice] = useState<Notice | undefined>();
  /**
   * The second window itself. A view setting, living here rather than on
   * `OpticalSystem` for the same reason the field checkboxes do: where a panel is
   * shown is not part of the design, and opening one must not land on the undo
   * stack.
   */
  const [secondary, setSecondary] = useState<SecondaryWindowHandle | undefined>();
  /**
   * The second window's own arrangement.
   *
   * Two trees, not one: a second display is a second place to *lay panels out*,
   * not a shelf to send them to. Kept while the window is shut so reopening
   * brings back whatever was arranged there, rather than starting over.
   */
  const [secondaryWorkspace, setSecondaryWorkspace] = useState(DEFAULT_SECONDARY_WORKSPACE);

  /**
   * Which panels are open at all — what the traces below are gated on.
   *
   * Both windows, because a Layout 3D opened only on the second display still
   * needs its pupil grid and still has to fetch Three.js. The gate asks whether
   * anything is showing it, not where.
   */
  const openPanels = useMemo(
    () => new Set([...panelsOnScreen(workspace), ...panelsOnScreen(secondaryWorkspace)]),
    [workspace, secondaryWorkspace],
  );
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
      setFieldVisibility([]);
      setCycleBase(undefined);
      setNotice(undefined);
      // Neither the blank system nor the sample doublet came from a file.
      setFileName(undefined);
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

  // Keep the selected field valid when the field list shrinks.
  const activeField = Math.min(fieldIndex, Math.max(system.fields.length - 1, 0));

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

  const firstOrder = useMemo(() => computeFirstOrder(system), [system]);
  const pupilRadius = firstOrder.ok ? firstOrder.value.entrancePupilRadius : 10;

  const wavelengthIndices = useMemo(
    () =>
      allWavelengths
        ? system.wavelengthsNm.map((_, index) => index)
        : [system.primaryWavelengthIndex],
    [allWavelengths, system],
  );

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

  const visibleFieldIndices = useMemo(
    () => allFieldIndices(system).filter((index) => fieldVisibility[index] ?? true),
    [system, fieldVisibility],
  );

  const plane = VIEW_PLANES[planeId];
  /**
   * Whether the first-order construction can be drawn. The marginal and chief
   * rays are defined through the fields, and the fields are y heights and y
   * angles, so both rays lie in the y–z plane: anywhere else they are a line on
   * the axis or a single point, which would be an overlay that draws something
   * and says nothing.
   */
  const meridional = planeId === 'YZ';

  // The rays the 2-D view draws, spread so that they lie in the plane it is
  // drawing. A fan is a flat sheet, and seen edge-on it is a line: the sagittal
  // view needs its fan spread in x or it draws a lens with one ray through it,
  // and end-on no fan works at all, so there the picture is filled with the same
  // pupil grid the 3-D view uses — which is what an end-on view wants anyway,
  // being a footprint.
  const layout = useMemo(
    () =>
      !openPanels.has('layout2d')
        ? undefined
        : plane.fanAxis === undefined
          ? computeVolumeTraces(system, {
              gridCount: gridAcrossPupil(raysPerFan),
              wavelengthIndices,
              fieldIndices: visibleFieldIndices,
            })
          : computeLayoutTraces(system, {
              raysPerFan,
              fanAxis: plane.fanAxis ?? 'y',
              wavelengthIndices,
              fieldIndices: visibleFieldIndices,
            }),
    [openPanels, plane, system, raysPerFan, wavelengthIndices, visibleFieldIndices],
  );

  // The first-order construction: the two rays it is built from, plus the two
  // pupil planes, which the first-order summary has already solved. Computed
  // only while it is on screen — it is a separate pair of traces, and it can
  // fail on its own (no aperture, a telecentric pupil) without touching the
  // ray bundle beside it.
  const firstOrderRays = useMemo(
    () =>
      showFirstOrder && meridional && openPanels.has('layout2d') && visibleFieldIndices.length > 0
        ? computeFirstOrderRays(system, visibleFieldIndices)
        : undefined,
    [showFirstOrder, meridional, openPanels, system, visibleFieldIndices],
  );
  // With every field switched off there is nothing for a construction ray to
  // belong to, so the overlay goes with them rather than quietly falling back to
  // a field that is not being drawn.
  const firstOrderOverlay =
    showFirstOrder && openPanels.has('layout2d') && meridional && visibleFieldIndices.length > 0
      ? buildFirstOrderOverlay(firstOrder, firstOrderRays)
      : undefined;

  // The 3-D view wants rays that fill the cone rather than a fan lying in one
  // plane, and it is the only thing that needs them, so they are not traced
  // until it is on screen. The grid is derived from the same rays-per-fan
  // control: a grid of n across the pupil is the same density as a fan of n.
  const volume = useMemo(
    () =>
      openPanels.has('layout3d')
        ? computeVolumeTraces(system, {
            gridCount: gridAcrossPupil(raysPerFan),
            fieldIndices: visibleFieldIndices,
            wavelengthIndices,
          })
        : undefined,
    [openPanels, system, raysPerFan, wavelengthIndices, visibleFieldIndices],
  );
  const fan = useMemo(() => computeRayFan(system, activeField, 21), [system, activeField]);
  const spot = useMemo(() => computeSpot(system, activeField, 15), [system, activeField]);

  const loadFile = async (file: File): Promise<void> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = importZmx(bytes, { resolveMaterial: GLASS_CATALOG.resolver() });
      pushSystem(result.system);
      setFileName(file.name);
      setFieldIndex(0);
      // A different design brings different elements; see `startFrom`.
      setElementStyles({});
      // A file brings its own field list, so flags set against the previous
      // design mean nothing against this one. Everything starts visible.
      setFieldVisibility([]);
      setCycleBase(undefined);
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
    change: { label?: string; color?: string | undefined },
  ): void => {
    setElementStyles((current) => {
      const entry: { label?: string; color?: string } = { ...current[key], ...change };
      if (entry.color === undefined) {
        delete entry.color;
      }
      if (entry.label === undefined || entry.label.trim() === '') {
        delete entry.label;
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
  const raysControl = (
    <label className="inline hint">
      rays
      <input
        type="number"
        min={1}
        max={31}
        step={2}
        value={raysPerFan}
        style={{ width: 56 }}
        onChange={(event) =>
          setRaysPerFan(Math.max(1, Math.min(31, Number(event.target.value) || 1)))
        }
      />
    </label>
  );

  const wavelengthsControl = (
    <label className="inline hint">
      <input
        type="checkbox"
        checked={allWavelengths}
        onChange={(event) => setAllWavelengths(event.target.checked)}
      />
      all wavelengths
    </label>
  );

  /**
   * The panel a slot has been turned over to.
   *
   * Every panel is written once here and rendered wherever its slots happen to
   * be — slot*s*, because the same panel may be open several times. Two copies
   * are this same JSX reading this same state, which is the whole of why they
   * mirror each other: there is nothing keeping them in step because there is
   * nothing to keep in step. Add a field in one Source object panel and the
   * other shows it because both are rendering one `system`.
   */
  const renderPanel = (found: Pane, choice: PanelChoice): ReactNode => {
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
            <FirstOrderPanel system={system} firstOrder={firstOrder} choice={choice} />
          </ErrorBoundary>
        );
      case 'layout2d':
        return (
          <Panel
            title="Layout 2D"
            flush
            choice={choice}
            actions={
              <>
                {raysControl}
                {wavelengthsControl}
                {/* Only offered on the meridional cross-section: these are
                  construction lines through that one plane, and neither the
                  3-D view nor the other two planes draw them, so the control
                  would otherwise promise something that does not happen. */}
                {meridional ? (
                  <label
                    className="inline hint"
                    title="Draw the marginal and chief rays and the entrance and exit pupils — the four things first-order optics is built from"
                  >
                    <input
                      type="checkbox"
                      checked={showFirstOrder}
                      onChange={(event) => setShowFirstOrder(event.target.checked)}
                    />
                    first-order rays
                  </label>
                ) : null}
                <label className="inline hint" title={plane.description}>
                  plane
                  <select
                    value={planeId}
                    aria-label="Layout plane"
                    onChange={(event) => setPlaneId(event.target.value as ViewPlaneId)}
                  >
                    {VIEW_PLANE_IDS.map((id) => (
                      <option key={id} value={id}>
                        {VIEW_PLANES[id].label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  title="Fit the drawing to the panel again"
                  onClick={() => setReset2d((count) => count + 1)}
                >
                  Reset view
                </button>
              </>
            }
          >
            <ErrorBoundary label="Layout 2D">
              {layout?.ok ? (
                <>
                  <LayoutView
                    system={system}
                    traces={layout.value}
                    plane={plane}
                    defaultSemiDiameter={Number.isFinite(pupilRadius) ? pupilRadius : 10}
                    highlightedSurface={highlightedSurface}
                    elementColors={elementColors}
                    surfaceColors={surfaceColors}
                    resetSignal={reset2d}
                    firstOrder={firstOrderOverlay}
                  />
                  <FieldLegend system={system} fieldIndices={visibleFieldIndices} />
                  {/* Dash-only. Color belongs to the field now, so a colored
                    wavelength swatch would name a mapping that is not on screen. */}
                  {allWavelengths ? <WavelengthLegend system={system} pattern /> : null}
                  {firstOrderOverlay ? (
                    <FirstOrderLegend
                      rays={firstOrderOverlay.rays}
                      entrance={firstOrderOverlay.entrance}
                      exit={firstOrderOverlay.exit}
                      principal={firstOrderOverlay.principal}
                      units={system.units}
                    />
                  ) : null}
                  {showFirstOrder && meridional && firstOrderRays?.ok === false ? (
                    <p className="hint" style={{ padding: '0 12px 10px' }}>
                      No first-order rays: {firstOrderRays.error}
                    </p>
                  ) : null}
                  <p className="hint view-hint">Wheel zooms · drag pans</p>
                </>
              ) : (
                <div style={{ padding: 12 }}>
                  <ErrorNote message={layout?.ok === false ? layout.error : 'No rays to draw.'} />
                </div>
              )}
            </ErrorBoundary>
          </Panel>
        );
      case 'layout3d':
        return (
          <Panel
            title="Layout 3D"
            flush
            choice={choice}
            actions={
              <>
                {raysControl}
                {wavelengthsControl}
                <button
                  title="Put the camera back where it started"
                  onClick={() => setReset3d((count) => count + 1)}
                >
                  Reset view
                </button>
              </>
            }
          >
            <ErrorBoundary label="Layout 3D">
              {volume?.ok ? (
                <>
                  <Suspense
                    fallback={
                      <p className="hint" style={{ padding: 12 }}>
                        Loading the 3D view…
                      </p>
                    }
                  >
                    <Layout3DView
                      system={system}
                      traces={volume.value}
                      defaultSemiDiameter={Number.isFinite(pupilRadius) ? pupilRadius : 10}
                      highlightedSurface={highlightedSurface}
                      elementColors={elementColors}
                      surfaceColors={surfaceColors}
                      resetSignal={reset3d}
                    />
                  </Suspense>
                  <FieldLegend system={system} fieldIndices={visibleFieldIndices} />
                  {/* No wavelength legend here: a line material has no dash to
                    offer, so in 3-D the wavelengths are drawn but not
                    distinguished, and a legend would name a cue that is absent. */}
                  <p className="hint view-hint">Wheel zooms · drag pans · wheel-drag orbits</p>
                </>
              ) : (
                <div style={{ padding: 12 }}>
                  <ErrorNote message={volume?.ok === false ? volume.error : 'No rays to draw.'} />
                </div>
              )}
            </ErrorBoundary>
          </Panel>
        );
      case 'analysis':
        return (
          <Panel
            title="Analysis"
            flush
            choice={choice}
            actions={
              <label className="inline hint">
                field
                <select
                  value={activeField}
                  onChange={(event) => setFieldIndex(Number(event.target.value))}
                  disabled={system.fields.length === 0}
                >
                  {(system.fields.length > 0 ? system.fields : [null]).map((_, index) => (
                    <option value={index} key={index}>
                      {fieldLabel(index)}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            <ErrorBoundary label="Analysis">
              <div className="plot-grid" style={{ padding: 12 }}>
                <div>
                  <h3 className="stat-label">Ray fan — tangential</h3>
                  {fan.ok ? (
                    <RayFanPlot data={fan.value} title={`Ray fan at ${fieldLabel(activeField)}`} />
                  ) : (
                    <ErrorNote message={fan.error} />
                  )}
                </div>
                <div>
                  <h3 className="stat-label">Spot diagram</h3>
                  {spot.ok ? (
                    <>
                      <SpotDiagram data={spot.value} title={`Spot at ${fieldLabel(activeField)}`} />
                      <p className="hint" style={{ margin: '4px 0 0' }}>
                        RMS radius {formatMicrons(spot.value.rmsRadius)} · max{' '}
                        {formatMicrons(spot.value.maxRadius)} · {spot.value.traced} rays
                        {spot.value.blocked > 0 ? `, ${spot.value.blocked} blocked` : ''}
                      </p>
                    </>
                  ) : (
                    <ErrorNote message={spot.error} />
                  )}
                </div>
              </div>
              <WavelengthLegend system={system} />
            </ErrorBoundary>
          </Panel>
        );
    }
  };

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
  const renderNode = (
    node: LayoutNode,
    update: Dispatch<SetStateAction<Workspace>>,
    onlyPane: boolean,
  ): ReactNode => {
    if (node.kind === 'pane') {
      const choice = choiceOf(node, update, onlyPane);
      return (
        <Fragment key={node.key}>
          {node.panel === undefined ? <BlankPanel choice={choice} /> : renderPanel(node, choice)}
        </Fragment>
      );
    }

    const across = node.direction === 'row';
    const tracks = `minmax(0, ${node.ratio}fr) ${SPLITTER_PX}px minmax(0, ${1 - node.ratio}fr)`;
    return (
      <div
        key={node.key}
        className={`split split-${node.direction}`}
        style={across ? { gridTemplateColumns: tracks } : { gridTemplateRows: tracks }}
      >
        {renderNode(node.first, update, false)}
        <Splitter
          // The divider runs across the direction it moves in, which is the easy
          // thing to get backwards: side-by-side panels are parted by an upright
          // bar, and `aria-orientation` names the bar.
          orientation={across ? 'vertical' : 'horizontal'}
          label={`Resize ${nodeName(node.first)}`}
          valueNow={node.ratio}
          onResize={(delta) => update((current) => resizeSplit(current, node.key, delta))}
        />
        {renderNode(node.second, update, false)}
      </div>
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

        <label className="inline">
          <span className="hint">Open .zmx</span>
          <input
            type="file"
            accept=".zmx,.ZMX"
            style={{ maxWidth: 190 }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void loadFile(file);
              }
              event.target.value = '';
            }}
          />
        </label>

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

      <div className="workspace">
        {renderNode(workspace.root, setWorkspace, workspace.root.kind === 'pane')}
      </div>

      {secondary ? (
        <SecondaryWindow
          handle={secondary}
          title={`Isaac — ${system.name}`}
          onClose={forgetSecondary}
        >
          <div className="workspace">
            {renderNode(
              secondaryWorkspace.root,
              setSecondaryWorkspace,
              secondaryWorkspace.root.kind === 'pane',
            )}
          </div>
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

function buildFirstOrderOverlay(
  firstOrder: Result<FirstOrder>,
  rays: Result<FirstOrderRays> | undefined,
): FirstOrderOverlay {
  if (!firstOrder.ok) {
    return { rays: undefined, entrance: undefined, exit: undefined, principal: undefined };
  }
  const { entrance, exit, entrancePupilRadius: beamRadius, properties } = firstOrder.value;
  const fill = entrance && entrance.radius > 0 ? beamRadius / entrance.radius : 1;
  const { frontPrincipalPlaneZ, rearPrincipalPlaneZ } = properties;
  return {
    rays: rays?.ok ? rays.value : undefined,
    entrance: entrance ? { z: entrance.z, radius: beamRadius } : undefined,
    exit: exit ? { z: exit.z, radius: exit.radius * fill } : undefined,
    // Drawn to the beam's height, like the pupils: the incoming ray and the
    // outgoing one meet on a principal plane at the height they came in at, so
    // the beam radius is the extent that construction actually spans.
    principal:
      Number.isFinite(frontPrincipalPlaneZ) || Number.isFinite(rearPrincipalPlaneZ)
        ? { frontZ: frontPrincipalPlaneZ, rearZ: rearPrincipalPlaneZ, radius: beamRadius }
        : undefined,
  };
}
