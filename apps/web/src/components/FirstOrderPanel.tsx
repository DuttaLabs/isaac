import type { OpticalSystem } from '@isaac/optical-core';
import type { FirstOrder } from '../lib/analysis.ts';
import { formatOptional } from '../lib/format.ts';
import type { Result } from '../lib/result.ts';
import { ErrorNote, Panel } from './Panel.tsx';

/** The first-order numbers a designer checks constantly while editing. */
export function FirstOrderPanel({
  system,
  firstOrder,
}: {
  system: OpticalSystem;
  firstOrder: Result<FirstOrder>;
}) {
  if (!firstOrder.ok) {
    return (
      <Panel title="First order">
        <ErrorNote message={firstOrder.error} />
      </Panel>
    );
  }

  const { properties, entrancePupilRadius, fNumber, entrance, exit } = firstOrder.value;
  const unit = system.units;
  const focusError = properties.imageSurfaceZ - properties.paraxialImageZ;
  // "At focus" has to be judged against the system's own scale: 2 µm matters on
  // a 5 mm lens and is nothing on a 100 mm one.
  const focusTolerance = Math.max(1e-6, Math.abs(properties.effectiveFocalLength) * 1e-4);

  return (
    <Panel
      title="First order"
      actions={<span className="hint">at {system.primaryWavelengthNm.toFixed(1)} nm</span>}
    >
      <div className="readout">
        <Stat label="Focal length" value={formatOptional(properties.effectiveFocalLength, 4, ` ${unit}`)} />
        <Stat label="Back focal dist." value={formatOptional(properties.backFocalDistance, 4, ` ${unit}`)} />
        <Stat label="F/#" value={fNumber === undefined ? '—' : `f/${fNumber.toFixed(2)}`} />
        <Stat label="Entrance pupil ⌀" value={formatOptional(2 * entrancePupilRadius, 3, ` ${unit}`)} />
        <Stat
          label="Image distance"
          value={formatOptional(properties.imageDistance, 4, ` ${unit}`)}
        />
        <Stat
          label="Magnification"
          value={properties.magnification === 0 ? '— (object at ∞)' : properties.magnification.toFixed(4)}
        />
        <Stat
          label="Defocus"
          value={formatOptional(focusError, 4, ` ${unit}`)}
          hint={
            Math.abs(focusError) < focusTolerance
              ? 'image is at paraxial focus'
              : 'image plane is off paraxial focus'
          }
        />
        <Stat
          label="Stop"
          value={system.stopIndex === undefined ? 'none set' : `surface ${system.stopIndex}`}
        />
        {entrance ? (
          <Stat
            label="Entrance pupil z"
            value={formatOptional(entrance.z, 3, ` ${unit}`)}
            hint={`⌀ ${formatOptional(2 * entrance.radius, 3)} ${unit}`}
          />
        ) : null}
        {exit ? (
          <Stat
            label="Exit pupil z"
            value={formatOptional(exit.z, 3, ` ${unit}`)}
            hint={`⌀ ${formatOptional(2 * exit.radius, 3)} ${unit}`}
          />
        ) : null}
      </div>
    </Panel>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
