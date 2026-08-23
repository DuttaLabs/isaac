import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { importZmx } from '@isaac/zemax-io';
import {
  computeFirstOrder,
  computeFirstOrderRays,
  computeLayoutTraces,
  computeRayFan,
  computeSpot,
  computeVolumeTraces,
  type FirstOrder,
  type FirstOrderRays,
} from './lib/analysis.ts';
import { defaultSystem } from './lib/default-system.ts';
import { GLASS_CATALOG } from './lib/materials.ts';
import { formatMicrons } from './lib/format.ts';
import { describeError, type Result } from './lib/result.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ErrorNote, Panel } from './components/Panel.tsx';
import { FirstOrderPanel } from './components/FirstOrderPanel.tsx';
import { FullScreenButton } from './components/FullScreenButton.tsx';
import { LayoutView, type FirstOrderOverlay } from './components/LayoutView.tsx';
import { FirstOrderLegend } from './components/FirstOrderLegend.tsx';
import { LensDataEditor } from './components/LensDataEditor.tsx';
import { RayFanPlot } from './components/RayFanPlot.tsx';
import { SourcePanel } from './components/SourcePanel.tsx';
import { SpotDiagram } from './components/SpotDiagram.tsx';
import { WavelengthLegend } from './components/WavelengthLegend.tsx';

// Three.js and its React bindings are most of the bundle, and a session that
// never opens the 3-D view should never download them. Loaded on first use.
const Layout3DView = lazy(() =>
  import('./components/Layout3DView.tsx').then((module) => ({ default: module.Layout3DView })),
);

const HISTORY_LIMIT = 50;
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

export function App() {
  const [history, setHistory] = useState(() => ({ stack: [defaultSystem()], index: 0 }));
  const [theme, setTheme] = useState<Theme>('light');
  const [fieldIndex, setFieldIndex] = useState(0);
  const [raysPerFan, setRaysPerFan] = useState(9);
  const [showFirstOrder, setShowFirstOrder] = useState(false);
  const [allWavelengths, setAllWavelengths] = useState(false);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  /** Bumped by the reset button; both views watch it and nothing else does. */
  const [viewReset, setViewReset] = useState(0);
  const [notice, setNotice] = useState<Notice | undefined>();
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

  const firstOrder = useMemo(() => computeFirstOrder(system), [system]);
  const pupilRadius = firstOrder.ok ? firstOrder.value.entrancePupilRadius : 10;

  const wavelengthIndices = useMemo(
    () =>
      allWavelengths
        ? system.wavelengthsNm.map((_, index) => index)
        : [system.primaryWavelengthIndex],
    [allWavelengths, system],
  );

  const layout = useMemo(
    () => computeLayoutTraces(system, { raysPerFan, wavelengthIndices }),
    [system, raysPerFan, wavelengthIndices],
  );

  // The first-order construction: the two rays it is built from, plus the two
  // pupil planes, which the first-order summary has already solved. Computed
  // only while it is on screen — it is a separate pair of traces, and it can
  // fail on its own (no aperture, a telecentric pupil) without touching the
  // ray bundle beside it.
  const firstOrderRays = useMemo(
    () => (showFirstOrder ? computeFirstOrderRays(system) : undefined),
    [showFirstOrder, system],
  );
  const firstOrderOverlay =
    showFirstOrder && view === '2d'
      ? buildFirstOrderOverlay(firstOrder, firstOrderRays)
      : undefined;

  // The 3-D view wants rays that fill the cone rather than a fan lying in one
  // plane, and it is the only thing that needs them, so they are not traced
  // until it is on screen. The grid is derived from the same rays-per-fan
  // control: a grid of n across the pupil is the same density as a fan of n.
  const volume = useMemo(
    () =>
      view === '3d'
        ? computeVolumeTraces(system, {
            gridCount: Math.max(3, Math.min(raysPerFan, 15)),
            wavelengthIndices,
          })
        : undefined,
    [view, system, raysPerFan, wavelengthIndices],
  );
  const fan = useMemo(() => computeRayFan(system, activeField, 21), [system, activeField]);
  const spot = useMemo(() => computeSpot(system, activeField, 15), [system, activeField]);

  const loadFile = async (file: File): Promise<void> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = importZmx(bytes, { resolveMaterial: GLASS_CATALOG.resolver() });
      pushSystem(result.system);
      setFieldIndex(0);
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

  const fieldLabel = (index: number): string => {
    const field = system.fields[index];
    if (!field) {
      return 'on axis';
    }
    return field.angleDeg !== undefined
      ? `${field.angleDeg}°`
      : `h = ${field.objectHeight ?? 0} ${system.units}`;
  };

  return (
    <div className="app">
      <header className="app-bar">
        <h1 className="app-title">Isaac</h1>
        <span className="app-subtitle">{system.name}</span>

        <div className="app-bar-spacer" />

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
        <button
          onClick={() => {
            pushSystem(defaultSystem());
            setNotice(undefined);
          }}
        >
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
        <div className="column">
          <ErrorBoundary label="Source object">
            <SourcePanel system={system} onChange={pushSystem} />
          </ErrorBoundary>
          <ErrorBoundary label="Optical system">
            <LensDataEditor
              system={system}
              onChange={pushSystem}
              onHighlight={setHighlightedSurface}
              highlightedSurface={highlightedSurface}
            />
          </ErrorBoundary>
          <ErrorBoundary label="First order">
            <FirstOrderPanel system={system} firstOrder={firstOrder} />
          </ErrorBoundary>
        </div>

        <div className="column">
          <Panel
            title="Layout"
            flush
            actions={
              <>
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
                <label className="inline hint">
                  <input
                    type="checkbox"
                    checked={allWavelengths}
                    onChange={(event) => setAllWavelengths(event.target.checked)}
                  />
                  all wavelengths
                </label>
                {/* Only offered on the cross-section: these are construction
                    lines through the meridional plane, and the 3-D view does not
                    draw them, so the control would otherwise promise something
                    that does not happen. */}
                {view === '2d' ? (
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
                <button
                  title={
                    view === '2d'
                      ? 'Show the system as a solid, free to orbit'
                      : 'Back to the meridional cross-section'
                  }
                  aria-pressed={view === '3d'}
                  onClick={() => setView(view === '2d' ? '3d' : '2d')}
                >
                  <span className="label-swap">
                    <span className={view === '2d' ? undefined : 'label-hidden'}>3D</span>
                    <span className={view === '2d' ? 'label-hidden' : undefined}>2D</span>
                  </span>
                </button>
                <button
                  title={
                    view === '2d'
                      ? 'Fit the drawing to the panel again'
                      : 'Put the camera back where it started'
                  }
                  onClick={() => setViewReset((count) => count + 1)}
                >
                  Reset view
                </button>
              </>
            }
          >
            <ErrorBoundary label="Layout">
              {layout.ok ? (
                <>
                  {view === '2d' ? (
                    <LayoutView
                      system={system}
                      traces={layout.value}
                      defaultSemiDiameter={Number.isFinite(pupilRadius) ? pupilRadius : 10}
                      highlightedSurface={highlightedSurface}
                      resetSignal={viewReset}
                      firstOrder={firstOrderOverlay}
                    />
                  ) : volume?.ok ? (
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
                        resetSignal={viewReset}
                      />
                    </Suspense>
                  ) : (
                    <div style={{ padding: 12 }}>
                      <ErrorNote
                        message={volume?.ok === false ? volume.error : 'No rays to draw.'}
                      />
                    </div>
                  )}
                  {allWavelengths ? <WavelengthLegend system={system} /> : null}
                  {firstOrderOverlay ? (
                    <FirstOrderLegend
                      rays={firstOrderOverlay.rays}
                      entrance={firstOrderOverlay.entrance}
                      exit={firstOrderOverlay.exit}
                      units={system.units}
                    />
                  ) : null}
                  {showFirstOrder && view === '2d' && firstOrderRays?.ok === false ? (
                    <p className="hint" style={{ padding: '0 12px 10px' }}>
                      No first-order rays: {firstOrderRays.error}
                    </p>
                  ) : null}
                  <p className="hint view-hint">
                    {view === '2d'
                      ? 'Wheel zooms · drag pans'
                      : 'Wheel zooms · drag pans · wheel-drag orbits'}
                  </p>
                </>
              ) : (
                <div style={{ padding: 12 }}>
                  <ErrorNote message={layout.error} />
                </div>
              )}
            </ErrorBoundary>
          </Panel>

          <Panel
            title="Analysis"
            flush
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
        </div>
      </div>
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
function buildFirstOrderOverlay(
  firstOrder: Result<FirstOrder>,
  rays: Result<FirstOrderRays> | undefined,
): FirstOrderOverlay {
  if (!firstOrder.ok) {
    return { rays: undefined, entrance: undefined, exit: undefined };
  }
  const { entrance, exit, entrancePupilRadius: beamRadius } = firstOrder.value;
  const fill = entrance && entrance.radius > 0 ? beamRadius / entrance.radius : 1;
  return {
    rays: rays?.ok ? rays.value : undefined,
    entrance: entrance ? { z: entrance.z, radius: beamRadius } : undefined,
    exit: exit ? { z: exit.z, radius: exit.radius * fill } : undefined,
  };
}
