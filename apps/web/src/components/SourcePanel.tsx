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
}: {
  system: OpticalSystem;
  onChange: (system: OpticalSystem) => void;
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
                      system.withSurfaceAt(0, system.objectSurface.with({ thickness: Math.abs(next) })),
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
            onChange={(event) =>
              apply(setApertureType(system, event.target.value as ApertureType))
            }
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
        onChange={(values) =>
          apply(
            attempt(() =>
              system.with({
                fields: values.map((value): Field => (atInfinity ? { angleDeg: value } : { objectHeight: value })),
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

/** A short editable list of numbers, optionally with one marked primary. */
function ListEditor({
  label,
  values,
  onChange,
  primaryIndex,
  onPrimaryChange,
}: {
  label: string;
  values: number[];
  onChange: (values: number[]) => void;
  primaryIndex?: number;
  onPrimaryChange?: (index: number) => void;
}) {
  return (
    <div className="field-row" style={{ alignItems: 'start' }}>
      <label>{label}</label>
      <div>
        {values.map((value, index) => (
          <div className="list-row" key={index}>
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
            <button
              className="subtle"
              aria-label={`Remove entry ${index + 1}`}
              disabled={values.length <= 1}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        ))}
        <button className="subtle" onClick={() => onChange([...values, values[values.length - 1] ?? 0])}>
          + add
        </button>
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
    const value = existing && existing.type === type ? (existing.value ?? defaults[type]) : defaults[type];
    return system.with({ aperture: { type, value } });
  });
}
