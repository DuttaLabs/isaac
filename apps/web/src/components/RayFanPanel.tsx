import { useMemo } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { computeRayFan } from '../lib/analysis.ts';
import { fieldLabel } from '../lib/fields.ts';
import type { RayFanSettings } from '../lib/panel-settings.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { FieldChoice } from './FieldChoice.tsx';
import { ErrorNote, Panel, type PanelChoice } from './Panel.tsx';
import { RaysControl } from './PlotControls.tsx';
import { RayFanPlot } from './RayFanPlot.tsx';
import { WavelengthLegend } from './WavelengthLegend.tsx';

/**
 * Transverse aberration across the pupil, at one field.
 *
 * A panel of its own rather than half of a combined Analysis panel, which is
 * what makes two of them useful: one at the axis and one at the corner of the
 * field, side by side, is how a fan is actually read. It is also the shape the
 * rest of the analyses want — each new plot type is another entry in the panel
 * list, and the header dropdown picks it up with nothing else changed.
 */

interface Props {
  system: OpticalSystem;
  settings: RayFanSettings;
  onSettings: (next: RayFanSettings) => void;
  choice: PanelChoice;
}

export function RayFanPanel({ system, settings, onSettings, choice }: Props) {
  const field = Math.min(settings.field, Math.max(system.fields.length - 1, 0));
  const fan = useMemo(
    () => computeRayFan(system, field, settings.raysPerFan),
    [system, field, settings.raysPerFan],
  );

  return (
    <Panel
      title="Ray fan"
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
      <ErrorBoundary label="Ray fan">
        <h3 className="stat-label">Ray fan — tangential</h3>
        {fan.ok ? (
          <>
            <RayFanPlot data={fan.value} title={`Ray fan at ${fieldLabel(system.fields[field])}`} />
            <WavelengthLegend system={system} />
          </>
        ) : (
          <ErrorNote message={fan.error} />
        )}
      </ErrorBoundary>
    </Panel>
  );
}
