import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { importZmx } from '@isaac/zemax-io';
import { computeFirstOrder, computeLayoutTraces, computeRayFan, computeSpot } from './lib/analysis.ts';
import { GLASS_CATALOG, defaultSystem } from './lib/default-system.ts';
import { formatMicrons } from './lib/format.ts';
import { describeError } from './lib/result.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ErrorNote, Panel } from './components/Panel.tsx';
import { FirstOrderPanel } from './components/FirstOrderPanel.tsx';
import { LayoutView } from './components/LayoutView.tsx';
import { LensDataEditor } from './components/LensDataEditor.tsx';
import { RayFanPlot } from './components/RayFanPlot.tsx';
import { SourcePanel } from './components/SourcePanel.tsx';
import { SpotDiagram } from './components/SpotDiagram.tsx';
import { WavelengthLegend } from './components/WavelengthLegend.tsx';

const HISTORY_LIMIT = 50;
type Theme = 'system' | 'light' | 'dark';

interface Notice {
  kind: 'error' | 'info';
  text: string;
  /** Things the file said that the reader could not honour exactly. */
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
  const [theme, setTheme] = useState<Theme>('system');
  const [fieldIndex, setFieldIndex] = useState(0);
  const [raysPerFan, setRaysPerFan] = useState(9);
  const [allWavelengths, setAllWavelengths] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();

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
    () => (allWavelengths ? system.wavelengthsNm.map((_, index) => index) : [system.primaryWavelengthIndex]),
    [allWavelengths, system],
  );

  const layout = useMemo(
    () => computeLayoutTraces(system, { raysPerFan, wavelengthIndices }),
    [system, raysPerFan, wavelengthIndices],
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

        <button onClick={() => setHistory((h) => ({ ...h, index: h.index - 1 }))} disabled={!canUndo}>
          Undo
        </button>
        <button onClick={() => setHistory((h) => ({ ...h, index: h.index + 1 }))} disabled={!canRedo}>
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
          onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}
          title="Cycle theme"
        >
          Theme: {theme}
        </button>
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
                    {notice.ignoredTokens.length} record types outside the optical prescription were not
                    imported
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
            <LensDataEditor system={system} onChange={pushSystem} />
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
              </>
            }
          >
            <ErrorBoundary label="Layout">
              {layout.ok ? (
                <>
                  <LayoutView
                    system={system}
                    traces={layout.value}
                    defaultSemiDiameter={Number.isFinite(pupilRadius) ? pupilRadius : 10}
                  />
                  {allWavelengths ? <WavelengthLegend system={system} /> : null}
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
