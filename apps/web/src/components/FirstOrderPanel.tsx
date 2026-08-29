import type { OpticalSystem } from '@isaac/optical-core';
import type { FirstOrder } from '../lib/analysis.ts';
import { formatOptional } from '../lib/format.ts';
import type { Result } from '../lib/result.ts';
import { ErrorNote, Panel, type PanelChoice } from './Panel.tsx';

/** The first-order numbers a designer checks constantly while editing. */
export function FirstOrderPanel({
  system,
  firstOrder,
  choice,
}: {
  system: OpticalSystem;
  firstOrder: Result<FirstOrder>;
  choice?: PanelChoice;
}) {
  if (!firstOrder.ok) {
    return (
      <Panel title="First order" choice={choice}>
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
      choice={choice}
      actions={<span className="hint">at {system.primaryWavelengthNm.toFixed(1)} nm</span>}
    >
      <div className="readout">
        <Stat
          label="Focal length"
          value={formatOptional(properties.effectiveFocalLength, 4, ` ${unit}`)}
        />
        <Stat
          label="Back focal dist."
          value={formatOptional(properties.backFocalDistance, 4, ` ${unit}`)}
        />
        <Stat label="F/#" value={fNumber === undefined ? '—' : `f/${fNumber.toFixed(2)}`} />
        <Stat
          label="Entrance pupil ⌀"
          value={formatOptional(2 * entrancePupilRadius, 3, ` ${unit}`)}
        />
        <Stat
          label="Image distance"
          value={formatOptional(properties.imageDistance, 4, ` ${unit}`)}
        />
        <Stat
          label="Magnification"
          value={
            properties.magnification === 0 ? '— (object at ∞)' : properties.magnification.toFixed(4)
          }
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

      {/* First-order optics describes a centered system: powers and separations
          measured along one straight axis. A coordinate transform bends or shifts
          that axis, and these numbers are then those of the *unfolded*
          equivalent — exactly right for a fold mirror, where the tilts cancel
          and only the path length matters, and an approximation once an element
          is genuinely tilted or decentered. Said plainly rather than left for a
          reader to discover, because nothing in the numbers themselves shows it. */}
      {!system.isCentered ? (
        <p className="hint">
          A coordinate transform moves the axis, so these are the first-order properties of the{' '}
          <strong>unfolded</strong> system. Distances are measured along the axis wherever it
          points; positions in z are not where the surfaces actually are.
        </p>
      ) : null}
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
