import { useEffect, useRef, useState } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { GLASS_CATALOG, glassName, resolveGlass } from '../lib/default-system.ts';
import {
  insertSurfaceAfter,
  normalizeRadius,
  normalizeSemiDiameter,
  removeSurface,
  setStop,
  setSurfaceType,
  updateSurface,
  type EditableSurfaceType,
} from '../lib/edits.ts';
import { quickFocus } from '../lib/focus.ts';
import { formatLength, formatMicrons } from '../lib/format.ts';
import type { Result } from '../lib/result.ts';
import { ErrorNote, Panel } from './Panel.tsx';
import { NumericCell } from './NumericCell.tsx';
import { TextCell } from './TextCell.tsx';

const GLASS_LIST_ID = 'glass-names';

/**
 * The spreadsheet the design is actually edited in. Every cell edit produces a
 * new OpticalSystem; if the model rejects the change the previous system stays
 * on screen and the reason is shown under the table.
 */
export function LensDataEditor({
  system,
  onChange,
  onHighlight,
  highlightedSurface,
}: {
  system: OpticalSystem;
  onChange: (system: OpticalSystem) => void;
  /** Reports the surface the user is on, so the layout can point it out. */
  onHighlight: (surfaceIndex: number | undefined) => void;
  /** The surface currently pointed out, which the arrow keys step through. */
  highlightedSurface: number | undefined;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const rows = useRef<(HTMLTableRowElement | null)[]>([]);
  const table = useRef<HTMLDivElement>(null);
  const [pointerInside, setPointerInside] = useState(false);

  const apply = (result: Result<OpticalSystem>): void => {
    if (result.ok) {
      setError(undefined);
      setStatus(undefined);
      onChange(result.value);
    } else {
      setError(result.error);
    }
  };

  /**
   * Runs the focus search and says what it did. The result is worth reporting
   * rather than silently applying: a thickness that barely moves is the honest
   * answer when the design is already focused, and looks like a broken button
   * otherwise.
   */
  const focus = (): void => {
    const result = quickFocus(system);
    if (!result.ok) {
      setStatus(undefined);
      setError(result.error);
      return;
    }
    const { previousRms, rms, previousThickness, thickness, surfaceIndex } = result.value;
    setError(undefined);
    setStatus(
      rms < previousRms
        ? `Focused on surface ${surfaceIndex}: thickness ${formatLength(previousThickness)} → ` +
            `${formatLength(thickness)}, RMS spot ${formatMicrons(previousRms)} → ${formatMicrons(rms)}.`
        : `Already at best focus: RMS spot ${formatMicrons(rms)}. Nothing moved.`,
    );
    onChange(result.value.system);
  };

  /**
   * Steps the highlight one row and moves focus with it.
   *
   * Focus follows so that the row keeps the keys — and so that an edit in
   * progress commits, since the cells commit on blur. `preventScroll` is the
   * point of the exercise: `focus()` would otherwise scroll the row into view,
   * which is the very page movement being suppressed.
   */
  const step = (delta: number): void => {
    const last = system.surfaces.length - 1;
    const next =
      highlightedSurface === undefined
        ? delta > 0
          ? 0
          : last
        : Math.min(last, Math.max(0, highlightedSurface + delta));
    onHighlight(next);
    rows.current[next]?.focus({ preventScroll: true });
  };

  const arrowKey = (key: string): number | undefined =>
    key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : undefined;

  /**
   * Arrow keys while the pointer is over the table but nothing in it has focus.
   * Without this the browser scrolls the page, and the row under a stationary
   * pointer changes — which looks like the highlight moving, but is the page
   * sliding underneath it.
   *
   * Only claimed when focus is nowhere in particular: if the user is typing in
   * a field elsewhere and the pointer happens to rest here, the keys are
   * theirs. When focus *is* inside the table, the React handler below has it.
   */
  useEffect(() => {
    if (!pointerInside) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const delta = arrowKey(event.key);
      if (delta === undefined) {
        return;
      }
      const active = document.activeElement;
      if (active !== null && active !== document.body) {
        return;
      }
      event.preventDefault();
      step(delta);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // `step` is re-made every render; it is only correct to keep a listener
    // holding one while the values it closes over are unchanged.
  }, [pointerInside, highlightedSurface, system.surfaces.length, onHighlight]);

  return (
    <Panel
      title="Optical system"
      flush
      actions={
        <>
          <button
            title="Move the image plane to the smallest RMS spot, over every field and wavelength"
            onClick={focus}
          >
            Quick focus
          </button>
          <span className="hint">
            {system.surfaces.length} surfaces · {system.units}
          </span>
        </>
      }
    >
      <datalist id={GLASS_LIST_ID}>
        {GLASS_CATALOG.names().map((name) => (
          <option value={name} key={name} />
        ))}
      </datalist>

      <div
        className="table-scroll"
        ref={table}
        onMouseEnter={() => setPointerInside(true)}
        onMouseLeave={() => setPointerInside(false)}
        onKeyDown={(event) => {
          // Arrows move between rows while focus is anywhere in the table,
          // including inside a cell being edited, which is how a lens grid is
          // expected to behave. Left and right are untouched, so text editing
          // in a cell still works.
          const delta = arrowKey(event.key);
          if (delta !== undefined) {
            event.preventDefault();
            step(delta);
          }
        }}
      >
        <table>
          <thead>
            <tr>
              <th>Surface</th>
              <th>Surface Type</th>
              <th className="text-column">Label</th>
              <th>Radius</th>
              <th>Focal length</th>
              <th>Thickness</th>
              <th>Glass</th>
              <th>Semi-dia</th>
              <th>Stop</th>
              <th aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {system.surfaces.map((surface, index) => {
              const isObject = surface.type === 'OBJECT';
              const isImage = surface.type === 'IMAGE';
              const isParaxial = surface.type === 'PARAXIAL';
              const isFixed = isObject || isImage;
              // Zemax names the ends of the system and the stop rather than
              // numbering them; everything else is its surface number.
              const label = isObject
                ? 'OBJ'
                : isImage
                  ? 'IMA'
                  : surface.isStop
                    ? 'STO'
                    : String(index);

              return (
                <tr
                  key={surface.id}
                  // Focusable only programmatically: the arrow keys land focus
                  // here, but Tab still walks the cells rather than the rows.
                  tabIndex={-1}
                  ref={(element) => {
                    rows.current[index] = element;
                  }}
                  className={index === highlightedSurface ? 'row-highlight' : undefined}
                  onMouseEnter={() => onHighlight(index)}
                  onMouseLeave={() => onHighlight(undefined)}
                  onFocus={() => onHighlight(index)}
                  onBlur={(event) => {
                    // Moving between cells of the same row must not blink the
                    // highlight off and on, so only a focus leaving the row
                    // clears it. React's onBlur bubbles, unlike the DOM's.
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      onHighlight(undefined);
                    }
                  }}
                >
                  <td className="row-label" title={`Surface ${index}`}>
                    {label}
                  </td>

                  <td>
                    <SurfaceTypeCell
                      type={surface.type}
                      fixed={isFixed}
                      ariaLabel={`Type of surface ${label}`}
                      onChange={(next) => apply(setSurfaceType(system, index, next))}
                    />
                  </td>

                  <td className="text-column">
                    <TextCell
                      value={surface.comment ?? ''}
                      placeholder="—"
                      ariaLabel={`Label for surface ${label}`}
                      title="A note naming this surface. Imported from and written as Zemax's COMM record."
                      onCommit={(next) => apply(updateSurface(system, index, { comment: next }))}
                    />
                  </td>

                  {/* Radius and focal length are the two ways a surface can carry
                      power, and no surface has both; the inapplicable one is blank. */}
                  <td>
                    {isParaxial ? (
                      <EmptyCell reason="A paraxial surface is a plane; its power is its focal length." />
                    ) : (
                      <NumericCell
                        value={surface.radius}
                        ariaLabel={`Radius of surface ${label}`}
                        title="Radius of curvature. 0 or blank means flat."
                        disabled={isFixed}
                        onCommit={(next) =>
                          apply(
                            updateSurface(system, index, {
                              radius: normalizeRadius(next),
                            }),
                          )
                        }
                      />
                    )}
                  </td>

                  <td>
                    {isParaxial ? (
                      <NumericCell
                        value={surface.focalLength ?? 0}
                        ariaLabel={`Focal length of surface ${label}`}
                        title="Focal length of the ideal thin lens. Negative diverges."
                        onCommit={(next) =>
                          apply(updateSurface(system, index, { focalLength: next }))
                        }
                      />
                    ) : (
                      <EmptyCell reason="Only a paraxial surface has a focal length." />
                    )}
                  </td>

                  <td>
                    <NumericCell
                      value={surface.thickness}
                      ariaLabel={`Thickness after surface ${label}`}
                      title="Distance to the next surface. The object may be Infinity."
                      disabled={isImage}
                      onCommit={(next) => apply(updateSurface(system, index, { thickness: next }))}
                    />
                  </td>

                  <td>
                    <GlassCell
                      surfaceName={glassName(surface.material)}
                      disabled={isImage}
                      onCommit={(material) => apply(updateSurface(system, index, { material }))}
                    />
                  </td>

                  <td>
                    <NumericCell
                      value={surface.semiDiameter}
                      ariaLabel={`Semi-diameter of surface ${label}`}
                      title="Clear aperture radius. 0 or blank means unapertured."
                      onCommit={(next) =>
                        apply(
                          updateSurface(system, index, {
                            semiDiameter: normalizeSemiDiameter(next),
                          }),
                        )
                      }
                    />
                  </td>

                  <td className="stop-cell">
                    <input
                      type="radio"
                      name="stop-surface"
                      checked={surface.isStop}
                      disabled={isFixed}
                      aria-label={`Make surface ${label} the aperture stop`}
                      onChange={() => apply(setStop(system, index))}
                    />
                  </td>

                  <td>
                    <button
                      className="subtle"
                      title="Insert a surface after this one"
                      aria-label={`Insert a surface after ${label}`}
                      onClick={() => apply(insertSurfaceAfter(system, index))}
                    >
                      +
                    </button>
                    <button
                      className="subtle"
                      title="Delete this surface"
                      aria-label={`Delete surface ${label}`}
                      disabled={isFixed}
                      onClick={() => apply(removeSurface(system, index))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error ? (
        <div style={{ padding: '10px 12px' }}>
          <ErrorNote message={error} />
        </div>
      ) : null}

      {status ? (
        <p className="hint" style={{ padding: '10px 12px', margin: 0 }}>
          {status}
        </p>
      ) : null}
    </Panel>
  );
}

/** The types a user may pick between, in the order they appear in the dropdown. */
const EDITABLE_SURFACE_TYPES: readonly EditableSurfaceType[] = ['STANDARD', 'PARAXIAL'];

/**
 * Surface type. OBJECT and IMAGE are fixed by their position in the system, so
 * they are shown as text rather than offered as choices that would be refused.
 */
function SurfaceTypeCell({
  type,
  fixed,
  ariaLabel,
  onChange,
}: {
  type: string;
  fixed: boolean;
  ariaLabel: string;
  onChange: (type: EditableSurfaceType) => void;
}) {
  if (fixed) {
    return (
      <span className="fixed-type" title="The ends of the system are fixed by position.">
        {type}
      </span>
    );
  }

  return (
    <select
      value={type}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value as EditableSurfaceType)}
    >
      {EDITABLE_SURFACE_TYPES.map((name) => (
        <option value={name} key={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

/** A column that does not apply to this surface type. */
function EmptyCell({ reason }: { reason: string }) {
  return (
    <span className="empty-cell" title={reason} aria-label={reason}>
      —
    </span>
  );
}

/** Glass name entry, backed by the catalogue and validated as you leave the cell. */
function GlassCell({
  surfaceName,
  disabled,
  onCommit,
}: {
  surfaceName: string;
  disabled: boolean;
  onCommit: (material: NonNullable<ReturnType<typeof resolveGlass>>) => void;
}) {
  const [draft, setDraft] = useState(surfaceName);
  const [editing, setEditing] = useState(false);
  const shown = editing ? draft : surfaceName;
  const resolved = resolveGlass(shown);

  return (
    <input
      list={GLASS_LIST_ID}
      value={shown}
      disabled={disabled}
      placeholder="air"
      aria-label="Glass"
      className={resolved ? undefined : 'invalid'}
      title={resolved ? undefined : `"${shown}" is not in the catalogue`}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => {
        setDraft(surfaceName);
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        const material = resolveGlass(draft);
        if (material && material.name !== surfaceName) {
          onCommit(material);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
