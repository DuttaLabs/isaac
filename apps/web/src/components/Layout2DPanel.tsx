import { useMemo, useState } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import {
  allFieldIndices,
  computeFirstOrderRays,
  computeLayoutTraces,
  computeVolumeTraces,
  gridAcrossPupil,
  type FirstOrder,
} from '../lib/analysis.ts';
import { fieldShown, type Layout2DSettings } from '../lib/panel-settings.ts';
import type { Result } from '../lib/result.ts';
import { VIEW_PLANES, VIEW_PLANE_IDS, type ViewPlaneId } from '../lib/view-plane.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { FieldLegend } from './FieldLegend.tsx';
import { FirstOrderLegend } from './FirstOrderLegend.tsx';
import { LayoutView, type FirstOrderOverlay } from './LayoutView.tsx';
import { ErrorNote, Panel, type PanelChoice } from './Panel.tsx';
import { PlotFieldFilter } from './PlotFieldFilter.tsx';
import { RaysControl, WavelengthsControl } from './PlotControls.tsx';
import { WavelengthLegend } from './WavelengthLegend.tsx';

/**
 * The 2-D cross-section, and everything that decides what it draws.
 *
 * The derivations live **here, not on `App`**, and that is the whole point of
 * the file existing. While there was one plane, one ray count and one field
 * list for the entire app, one `useMemo` in `App` could serve every copy of this
 * panel — and every copy therefore drew the same picture. Deriving inside the
 * component gives each pane its own memo keyed on its own settings, so two of
 * these on screen trace and draw independently, and neither recomputes when the
 * other is changed.
 *
 * It also retires the trace gate. `App` used to ask whether a Layout 2D was on
 * screen anywhere before tracing for it; a component that only exists when its
 * pane does answers that by existing.
 */

interface Props {
  system: OpticalSystem;
  settings: Layout2DSettings;
  onSettings: (next: Layout2DSettings) => void;
  choice: PanelChoice;
  /**
   * The Source panel's own Display flags — which fields are in play at all.
   * This panel narrows them further; it cannot widen them, which is what makes
   * Source the system-wide list and this one a per-plot filter.
   */
  sourceFields: readonly boolean[];
  firstOrder: Result<FirstOrder>;
  elementColors: ReadonlyMap<number, string>;
  surfaceColors: ReadonlyMap<number, string>;
  highlightedSurface: number | undefined;
}

export function Layout2DPanel({
  system,
  settings,
  onSettings,
  choice,
  sourceFields,
  firstOrder,
  elementColors,
  surfaceColors,
  highlightedSurface,
}: Props) {
  /**
   * Bumped by Reset view. Local state now rather than a counter on `App`: it is
   * a signal from a button in this panel to the drawing in the same panel, so
   * two of these no longer refit together — pressing Reset in one used to throw
   * away the framing set up in the other.
   */
  const [resetSignal, setResetSignal] = useState(0);

  const plane = VIEW_PLANES[settings.plane];
  /**
   * Whether the first-order construction can be drawn. The marginal and chief
   * rays are defined through the fields, and the fields are y heights and y
   * angles, so both lie in the y–z plane: anywhere else they are a line on the
   * axis or a single point, which would be an overlay that draws something and
   * says nothing.
   */
  const meridional = settings.plane === 'YZ';

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

  const traces = useMemo(
    () =>
      // End-on no fan works — every ray of a flat sheet lies on the axis seen
      // that way — so the pupil grid the 3-D view traces fills the picture
      // instead, which is what a footprint wants anyway.
      plane.fanAxis === undefined
        ? computeVolumeTraces(system, {
            gridCount: gridAcrossPupil(settings.raysPerFan),
            wavelengthIndices,
            fieldIndices,
          })
        : computeLayoutTraces(system, {
            raysPerFan: settings.raysPerFan,
            fanAxis: plane.fanAxis,
            wavelengthIndices,
            fieldIndices,
          }),
    [plane, system, settings.raysPerFan, wavelengthIndices, fieldIndices],
  );

  const wanted = settings.showFirstOrder && meridional && fieldIndices.length > 0;
  const firstOrderRays = useMemo(
    () => (wanted ? computeFirstOrderRays(system, fieldIndices) : undefined),
    [wanted, system, fieldIndices],
  );
  // With every field switched off there is nothing for a construction ray to
  // belong to, so the overlay goes with them rather than quietly falling back to
  // a field that is not being drawn.
  const overlay = wanted ? buildFirstOrderOverlay(firstOrder, firstOrderRays) : undefined;

  const pupilRadius = firstOrder.ok ? firstOrder.value.entrancePupilRadius : 10;

  return (
    <Panel
      title="Layout 2D"
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
          {/* Only offered on the meridional cross-section: these are
            construction lines through that one plane, and neither the 3-D view
            nor the other two planes draw them, so the control would otherwise
            promise something that does not happen. */}
          {meridional ? (
            <label
              className="inline hint"
              title="Draw the marginal and chief rays and the entrance and exit pupils — the four things first-order optics is built from"
            >
              <input
                type="checkbox"
                checked={settings.showFirstOrder}
                onChange={(event) =>
                  onSettings({ ...settings, showFirstOrder: event.target.checked })
                }
              />
              first-order rays
            </label>
          ) : null}
          <label className="inline hint" title={plane.description}>
            plane
            <select
              value={settings.plane}
              aria-label="Layout plane"
              onChange={(event) =>
                onSettings({ ...settings, plane: event.target.value as ViewPlaneId })
              }
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
            onClick={() => setResetSignal((count) => count + 1)}
          >
            Reset view
          </button>
        </>
      }
    >
      <ErrorBoundary label="Layout 2D">
        {traces.ok ? (
          <>
            {/* The drawing and anything laid over it. Only the picture is inside
              this box: the legends below are read alongside it, not on top of
              it, and a filter floating over a legend would cover the very thing
              it names. */}
            <div className="plot-stage">
              <LayoutView
                system={system}
                traces={traces.value}
                plane={plane}
                defaultSemiDiameter={Number.isFinite(pupilRadius) ? pupilRadius : 10}
                highlightedSurface={highlightedSurface}
                elementColors={elementColors}
                surfaceColors={surfaceColors}
                resetSignal={resetSignal}
                firstOrder={overlay}
              />
              <PlotFieldFilter
                system={system}
                sourceFields={sourceFields}
                fields={settings.fields}
                onChange={(fields) => onSettings({ ...settings, fields })}
              />
            </div>
            <FieldLegend system={system} fieldIndices={fieldIndices} />
            {/* Dash-only. Color belongs to the field now, so a colored
              wavelength swatch would name a mapping that is not on screen. */}
            {settings.allWavelengths ? <WavelengthLegend system={system} pattern /> : null}
            {overlay ? (
              <FirstOrderLegend
                rays={overlay.rays}
                entrance={overlay.entrance}
                exit={overlay.exit}
                principal={overlay.principal}
                units={system.units}
              />
            ) : null}
            {wanted && firstOrderRays?.ok === false ? (
              <p className="hint" style={{ padding: '0 12px 10px' }}>
                No first-order rays: {firstOrderRays.error}
              </p>
            ) : null}
            <p className="hint view-hint">Wheel zooms · drag pans</p>
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

function buildFirstOrderOverlay(
  firstOrder: Result<FirstOrder>,
  rays: ReturnType<typeof computeFirstOrderRays> | undefined,
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
