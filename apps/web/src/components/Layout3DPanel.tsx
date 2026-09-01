import { Suspense, lazy, useMemo, useState } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import {
  allFieldIndices,
  computeVolumeTraces,
  gridAcrossPupil,
  type FirstOrder,
} from '../lib/analysis.ts';
import { fieldShown, type Layout3DSettings } from '../lib/panel-settings.ts';
import type { Result } from '../lib/result.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { FieldLegend } from './FieldLegend.tsx';
import { ErrorNote, Panel, type PanelChoice } from './Panel.tsx';
import { PlotFieldFilter } from './PlotFieldFilter.tsx';
import { RaysControl, WavelengthsControl } from './PlotControls.tsx';

/**
 * The solid view, and what it traces.
 *
 * Three.js and its React bindings are most of the bundle, and a session that
 * never opens this view should never download them — so the view itself stays
 * behind `lazy()`. It lives *here* rather than in `App` now that the panel is a
 * component of its own: the gate used to be `App` asking whether a Layout 3D was
 * on screen anywhere, and a component that exists only while its pane does
 * answers that by existing.
 */
const Layout3DView = lazy(() =>
  import('./Layout3DView.tsx').then((module) => ({ default: module.Layout3DView })),
);

interface Props {
  system: OpticalSystem;
  settings: Layout3DSettings;
  onSettings: (next: Layout3DSettings) => void;
  choice: PanelChoice;
  sourceFields: readonly boolean[];
  firstOrder: Result<FirstOrder>;
  elementColors: ReadonlyMap<number, string>;
  /** Surfaces of elements switched out of the light: not drawn at all. */
  hiddenSurfaces: ReadonlySet<number>;
  surfaceColors: ReadonlyMap<number, string>;
  highlightedSurface: number | undefined;
}

export function Layout3DPanel({
  system,
  settings,
  onSettings,
  choice,
  sourceFields,
  firstOrder,
  elementColors,
  hiddenSurfaces,
  surfaceColors,
  highlightedSurface,
}: Props) {
  /** See `Layout2DPanel`: a signal from this panel's button to its own picture. */
  const [resetSignal, setResetSignal] = useState(0);

  const fieldIndices = useMemo(
    () =>
      allFieldIndices(system).filter(
        (index) => (sourceFields[index] ?? true) && fieldShown(settings.fields, index),
      ),
    [system, sourceFields, settings.fields],
  );

  const wavelengthIndices = useMemo(
    () =>
      settings.allWavelengths
        ? system.wavelengthsNm.map((_, index) => index)
        : [system.primaryWavelengthIndex],
    [settings.allWavelengths, system],
  );

  // Rays that fill the cone rather than a fan lying in one plane. The grid comes
  // from the same rays-per-fan control: a grid of n across the pupil is the same
  // density as a fan of n.
  const traces = useMemo(
    () =>
      computeVolumeTraces(system, {
        gridCount: gridAcrossPupil(settings.raysPerFan),
        fieldIndices,
        wavelengthIndices,
      }),
    [system, settings.raysPerFan, fieldIndices, wavelengthIndices],
  );

  const pupilRadius = firstOrder.ok ? firstOrder.value.entrancePupilRadius : 10;

  return (
    <Panel
      title="Layout 3D"
      flush
      choice={choice}
      actions={
        <>
          <RaysControl
            value={settings.raysPerFan}
            onChange={(raysPerFan) => onSettings({ ...settings, raysPerFan })}
          />
          <WavelengthsControl
            value={settings.allWavelengths}
            onChange={(allWavelengths) => onSettings({ ...settings, allWavelengths })}
          />
          <button
            title="Put the camera back where it started"
            onClick={() => setResetSignal((count) => count + 1)}
          >
            Reset view
          </button>
        </>
      }
    >
      <ErrorBoundary label="Layout 3D">
        {traces.ok ? (
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
                traces={traces.value}
                defaultSemiDiameter={Number.isFinite(pupilRadius) ? pupilRadius : 10}
                highlightedSurface={highlightedSurface}
                elementColors={elementColors}
                hiddenSurfaces={hiddenSurfaces}
                surfaceColors={surfaceColors}
                resetSignal={resetSignal}
                camera={settings.camera}
                onCamera={(camera) => onSettings({ ...settings, camera })}
                overlay={
                  <PlotFieldFilter
                    system={system}
                    sourceFields={sourceFields}
                    fields={settings.fields}
                    onChange={(fields) => onSettings({ ...settings, fields })}
                  />
                }
              />
            </Suspense>
            <FieldLegend system={system} fieldIndices={fieldIndices} />
            {/* No wavelength legend here: a line material has no dash to offer,
              so in 3-D the wavelengths are drawn but not distinguished, and a
              legend would name a cue that is absent. */}
            <p className="hint view-hint">Wheel zooms · drag pans · wheel-drag orbits</p>
          </>
        ) : (
          <div style={{ padding: 12 }}>
            <ErrorNote message={traces.error} />
          </div>
        )}
      </ErrorBoundary>
    </Panel>
  );
}
