import { useMemo } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { computeSpot } from '../lib/analysis.ts';
import { fieldLabel } from '../lib/fields.ts';
import { formatMicrons } from '../lib/format.ts';
import type { SpotSettings } from '../lib/panel-settings.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { FieldChoice } from './FieldChoice.tsx';
import { ErrorNote, Panel, type PanelChoice } from './Panel.tsx';
import { RaysControl } from './PlotControls.tsx';
import { SpotDiagram } from './SpotDiagram.tsx';
import { WavelengthLegend } from './WavelengthLegend.tsx';

/**
 * Where a pupil-full of rays lands on the image plane, at one field.
 *
 * Split out from the old combined Analysis panel for the same reason the ray fan
 * was: the two answer different questions, and wanting both at once was the only
 * thing keeping them in one panel — which the tree now does better, since two
 * panes side by side is exactly what that arrangement was imitating.
 */

interface Props {
  system: OpticalSystem;
  settings: SpotSettings;
  onSettings: (next: SpotSettings) => void;
  choice: PanelChoice;
}

export function SpotPanel({ system, settings, onSettings, choice }: Props) {
  const field = Math.min(settings.field, Math.max(system.fields.length - 1, 0));
  const spot = useMemo(
    () => computeSpot(system, field, settings.raysPerFan),
    [system, field, settings.raysPerFan],
  );

  return (
    <Panel
      title="Spot diagram"
      choice={choice}
      actions={
        <>
          <RaysControl
            value={settings.raysPerFan}
            onChange={(raysPerFan) => onSettings({ ...settings, raysPerFan })}
          />
          <FieldChoice
            system={system}
            value={field}
            onChange={(next) => onSettings({ ...settings, field: next })}
          />
        </>
      }
    >
      <ErrorBoundary label="Spot diagram">
        <h3 className="stat-label">Spot diagram</h3>
        {spot.ok ? (
          <>
            <SpotDiagram data={spot.value} title={`Spot at ${fieldLabel(system.fields[field])}`} />
            <p className="hint" style={{ margin: '4px 0 0' }}>
              RMS radius {formatMicrons(spot.value.rmsRadius)} · max{' '}
              {formatMicrons(spot.value.maxRadius)} · {spot.value.traced} rays
              {spot.value.blocked > 0 ? `, ${spot.value.blocked} blocked` : ''}
            </p>
            <WavelengthLegend system={system} />
          </>
        ) : (
          <ErrorNote message={spot.error} />
        )}
      </ErrorBoundary>
    </Panel>
  );
}
