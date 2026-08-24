import { useState } from 'react';
import type { ApertureType, Field, OpticalSystem } from '@isaac/optical-core';
import { attempt, type Result } from '../lib/result.ts';
import { ErrorNote, Panel } from './Panel.tsx';
import { NumericCell } from './NumericCell.tsx';

const APERTURE_LABELS: Record<ApertureType, string> = {
  ENTRANCE_PUPIL_DIAMETER: 'Entrance pupil diameter',
  IMAGE_SPACE_FNUM: 'Image-space F/#',
  OBJECT_SPACE_NA: 'Object-space NA',
  FLOAT_BY_STOP: 'Float by stop size',
};

/**
 * The source definition: where the light comes from (object conjugate and field
 * points), how much of it the system takes (aperture), and at what wavelengths.
 * Together these are what ray generation needs.
 */
export function SourcePanel({
  system,
  onChange,
  fieldVisibility,
  cyclingFields,
  onToggleFieldCycling,
  onFieldVisibilityChange,
}: {
  system: OpticalSystem;
  onChange: (system: OpticalSystem) => void;
  /**
   * Which fields the layout draws, one flag per field. A *view* setting rather
   * than part of the design, so it lives outside `OpticalSystem` — hiding a
   * field to see past it should not land on the undo stack or be written back
   * into a lens file.
   */
  fieldVisibility: readonly boolean[];
  /** True while the layout is showing the checked fields one at a time. */
  cyclingFields: boolean;
  onToggleFieldCycling: () => void;
  onFieldVisibilityChange: (next: boolean[]) => void;
}) {
  const [error, setError] = useState<string | undefined>(undefined);

  const apply = (result: Result<OpticalSystem>): void => {
    if (result.ok) {
      setError(undefined);
      onChange(result.value);
    } else {
      setError(result.error);
    }
  };

  const objectThickness = system.objectSurface.thickness;
  const atInfinity = !Number.isFinite(objectThickness);
  const aperture = system.aperture;

  return (
    <Panel title="Source object">
      <div className="field-row">
        <label htmlFor="object-conjugate">Object</label>
        <div className="inline">
          <select
            id="object-conjugate"
            value={atInfinity ? 'infinity' : 'finite'}
            onChange={(event) => apply(setConjugate(system, event.target.value === 'infinity'))}
          >
            <option value="infinity">At infinity</option>
            <option value="finite">Finite distance</option>
          </select>
          {atInfinity ? null : (
            <span style={{ width: 110 }}>
              <NumericCell
                value={objectThickness}
                ariaLabel="Object distance"
                onCommit={(next) =>
                  apply(
                    attempt(() =>
                      system.withSurfaceAt(
                        0,
                        system.objectSurface.with({ thickness: Math.abs(next) }),
                      ),
                    ),
                  )
                }
              />
            </span>
          )}
        </div>
      </div>

      <div className="field-row">
        <label htmlFor="aperture-type">Aperture</label>
        <div className="inline">
          <select
            id="aperture-type"
            value={aperture?.type ?? 'ENTRANCE_PUPIL_DIAMETER'}
            onChange={(event) => apply(setApertureType(system, event.target.value as ApertureType))}
          >
            {Object.entries(APERTURE_LABELS).map(([type, label]) => (
              <option value={type} key={type}>
                {label}
              </option>
            ))}
          </select>
          {aperture && aperture.type !== 'FLOAT_BY_STOP' ? (
            <span style={{ width: 90 }}>
              <NumericCell
                value={aperture.value ?? 0}
                ariaLabel="Aperture value"
                onCommit={(next) =>
                  apply(attempt(() => system.with({ aperture: { ...aperture, value: next } })))
                }
              />
            </span>
          ) : (
            <span className="hint">taken from the stop surface</span>
          )}
        </div>
      </div>

      <ListEditor
        label={atInfinity ? 'Field angles (°)' : 'Object heights'}
        values={system.fields.map((field) => field.angleDeg ?? field.objectHeight ?? 0)}
        visible={system.fields.map((_, index) => fieldVisibility[index] ?? true)}
        onVisibleChange={onFieldVisibilityChange}
        cycle={{
          active: cyclingFields,
          onToggle: onToggleFieldCycling,
          // Two is the fewest that can take turns; with one there is nothing to
          // tell apart, which is the only thing cycling is for. This gates
          // *starting* only — cycling itself leaves one field checked, so a
          // button disabled on the live count would switch on and then refuse
          // to switch off.
          canStart: system.fields.filter((_, index) => fieldVisibility[index] ?? true).length >= 2,
        }}
        onChange={(values) =>
          apply(
            attempt(() =>
              system.with({
                fields: values.map((value): Field =>
                  atInfinity ? { angleDeg: value } : { objectHeight: value },
                ),
              }),
            ),
          )
        }
      />

      <ListEditor
        label="Wavelengths (nm)"
        values={[...system.wavelengthsNm]}
        primaryIndex={system.primaryWavelengthIndex}
        onPrimaryChange={(index) =>
          apply(attempt(() => system.with({ primaryWavelengthIndex: index })))
        }
        onChange={(values) =>
          apply(
            attempt(() =>
              system.with({
                wavelengthsNm: values,
                primaryWavelengthIndex: Math.min(system.primaryWavelengthIndex, values.length - 1),
              }),
            ),
          )
        }
      />

      {error ? <ErrorNote message={error} /> : null}
    </Panel>
  );
}

/**
 * A short editable list of numbers, optionally with one marked primary and
 * optionally with a per-row Display checkbox.
 *
 * Adding and removing a row moves the visibility flags with it, here, because
 * this is the only place that knows *which* row went. Reconciling two lists by
 * length afterwards would silently re-point the flags at their neighbours the
 * moment a row is removed from the middle.
 */
function ListEditor({
  label,
  values,
  onChange,
  primaryIndex,
  onPrimaryChange,
  visible,
  onVisibleChange,
  cycle,
}: {
  label: string;
  values: number[];
  onChange: (values: number[]) => void;
  primaryIndex?: number;
  onPrimaryChange?: (index: number) => void;
  visible?: boolean[];
  onVisibleChange?: (next: boolean[]) => void;
  /** Shows the checked rows one at a time; only the fields list offers it. */
  cycle?: { active: boolean; onToggle: () => void; canStart: boolean };
}) {
  const showDisplay = visible !== undefined && onVisibleChange !== undefined;
  const rowClass = showDisplay ? 'list-row with-display' : 'list-row';

  const remove = (index: number): void => {
    onChange(values.filter((_, i) => i !== index));
    onVisibleChange?.(visible!.filter((_, i) => i !== index));
  };
  const add = (): void => {
    onChange([...values, values[values.length - 1] ?? 0]);
    // A field you have just asked for is one you want to see.
    onVisibleChange?.([...visible!, true]);
  };

  return (
    <div className="field-row" style={{ alignItems: 'start' }}>
      <label>{label}</label>
      <div>
        {showDisplay ? (
          // The heading sits in the checkbox's own grid column, so an empty cell
          // holds the value column open ahead of it.
          <div className={`${rowClass} list-head`} aria-hidden="true">
            <span />
            <span>Display</span>
          </div>
        ) : null}
        {values.map((value, index) => (
          <div className={rowClass} key={index}>
            {onPrimaryChange ? (
              <input
                type="radio"
                name={`primary-${label}`}
                checked={index === primaryIndex}
                aria-label={`Make entry ${index + 1} primary`}
                onChange={() => onPrimaryChange(index)}
              />
            ) : null}
            <NumericCell
              value={value}
              ariaLabel={`${label} entry ${index + 1}`}
              onCommit={(next) => onChange(values.map((old, i) => (i === index ? next : old)))}
            />
            {showDisplay ? (
              <input
                type="checkbox"
                className="display-check"
                checked={visible[index] ?? true}
                aria-label={`Draw ${label} entry ${index + 1} in the layout`}
                title="Draw this field in the layout. Unchecking it leaves the design untouched."
                onChange={(event) =>
                  onVisibleChange(
                    visible.map((shown, i) => (i === index ? event.target.checked : shown)),
                  )
                }
              />
            ) : null}
            <button
              className="subtle remove-entry"
              aria-label={`Remove entry ${index + 1}`}
              title={`Remove ${label} entry ${index + 1}`}
              disabled={values.length <= 1}
              onClick={() => remove(index)}
            >
              ×
            </button>
          </div>
        ))}
        <div className={cycle ? 'list-actions with-display' : 'list-actions'}>
          <button className="subtle" onClick={add}>
            + add
          </button>
          {/* Only the fields list offers this, and only once there are two
              checked to alternate between. It sits under the Display column,
              because that column is what it drives. */}
          {cycle ? (
            <button
              className={cycle.active ? 'cycle-fields cycling' : 'cycle-fields'}
              // Never disabled while running: cycling leaves one field checked,
              // so the condition that allows starting is false by the time the
              // button's job is to stop.
              disabled={!cycle.active && !cycle.canStart}
              aria-pressed={cycle.active}
              title={
                cycle.active || cycle.canStart
                  ? 'Show the checked fields one at a time, so a bundle can be told from its neighbours. Click again to stop and put the selection back.'
                  : 'Check at least two fields to cycle between them.'
              }
              onClick={cycle.onToggle}
            >
              {/* Two lines so the button stays narrow enough to sit in the
                  checkbox column. Its width is fixed in the stylesheet, so it
                  does not resize as the label changes. */}
              <span>{cycle.active ? 'Stop' : 'Cycle'}</span>
              <span>{cycle.active ? 'cycling' : 'fields'}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Switching conjugate has to convert the field list too: an object at infinity
 * takes angles and a finite object takes heights, and the engine rejects the
 * wrong kind. Angles convert as h = L·tan θ, which preserves the field's size
 * relative to the object plane.
 */
function setConjugate(system: OpticalSystem, toInfinity: boolean): Result<OpticalSystem> {
  return attempt(() => {
    const currentThickness = system.objectSurface.thickness;
    const distance = Number.isFinite(currentThickness) ? currentThickness : 200;

    const fields = system.fields.map((field): Field => {
      if (toInfinity) {
        const height = field.objectHeight ?? 0;
        return { angleDeg: (Math.atan2(height, distance) * 180) / Math.PI };
      }
      const angleRad = ((field.angleDeg ?? 0) * Math.PI) / 180;
      return { objectHeight: distance * Math.tan(angleRad) };
    });

    return system
      .with({ fields })
      .withSurfaceAt(0, system.objectSurface.with({ thickness: toInfinity ? Infinity : distance }));
  });
}

function setApertureType(system: OpticalSystem, type: ApertureType): Result<OpticalSystem> {
  return attempt(() => {
    if (type === 'FLOAT_BY_STOP') {
      return system.with({ aperture: { type } });
    }
    const defaults: Record<Exclude<ApertureType, 'FLOAT_BY_STOP'>, number> = {
      ENTRANCE_PUPIL_DIAMETER: 20,
      IMAGE_SPACE_FNUM: 5,
      OBJECT_SPACE_NA: 0.1,
    };
    const existing = system.aperture;
    const value =
      existing && existing.type === type ? (existing.value ?? defaults[type]) : defaults[type];
    return system.with({ aperture: { type, value } });
  });
}
