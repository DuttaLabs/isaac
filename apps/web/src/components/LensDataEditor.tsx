import { useEffect, useRef, useState } from 'react';
import type { Material, OpticalSystem } from '@isaac/optical-core';
import {
  GLASS_CATALOG,
  MIRROR_MATERIAL_LABEL,
  MODEL_GLASS_HINT,
  MODEL_MATERIAL_LABEL,
  isMirrorText,
  materialFromText,
  materialLabel,
  modelGlassFromText,
  modelGlassText,
} from '../lib/materials.ts';
import {
  insertSurfaceAfter,
  normalizeRadius,
  normalizeSemiDiameter,
  removeSurface,
  setMirror,
  setStop,
  setSurfaceType,
  updateCoordinateTransform,
  updateSurface,
  type EditableSurfaceType,
} from '../lib/edits.ts';
import { quickFocus } from '../lib/focus.ts';
import { formatLength, formatMicrons } from '../lib/format.ts';
import { chain, type Result } from '../lib/result.ts';
import { AsphericCoefficientsDialog, AsphericSummaryButton } from './AsphericCoefficients.tsx';
import {
  CoordinateTransformDialog,
  CoordinateTransformSummaryButton,
} from './CoordinateTransformEditor.tsx';
import { ErrorNote, Panel } from './Panel.tsx';
import { NumericCell } from './NumericCell.tsx';
import { TextCell } from './TextCell.tsx';

const MATERIAL_LIST_ID = 'material-names';

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
  /** Surface whose aspheric coefficients are open in the modal, if any. */
  const [asphereSurface, setAsphereSurface] = useState<number | undefined>(undefined);
  /** Surface whose coordinate transform is open in the modal, if any. */
  const [transformSurface, setTransformSurface] = useState<number | undefined>(undefined);
  const rows = useRef<(HTMLTableRowElement | null)[]>([]);
  const table = useRef<HTMLDivElement>(null);
  const [pointerInside, setPointerInside] = useState(false);

  // The row the cursor is on, by hover or by keyboard focus — both set
  // `highlightedSurface`. Guarded against an index left over from a system that
  // has since lost that surface.
  const headerIsTransform =
    highlightedSurface !== undefined &&
    highlightedSurface < system.surfaces.length &&
    system.surfaceAt(highlightedSurface).type === 'COORDINATE_TRANSFORM';

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
    const { previousRms, rms, previousThickness, thickness, surfaceIndex, droppedFields } =
      result.value;
    // Fields with no image at any focus are left out of the merit, so the number
    // does not speak for them and the user has to be told which ones.
    const caveat =
      droppedFields.length === 0
        ? ''
        : ` Field${droppedFields.length > 1 ? 's' : ''} ${droppedFields.join(', ')} ` +
          `left out: nothing of ${droppedFields.length > 1 ? 'them' : 'it'} reaches the image.`;
    setError(undefined);
    setStatus(
      (rms < previousRms
        ? `Focused on surface ${surfaceIndex}: thickness ${formatLength(previousThickness)} → ` +
          `${formatLength(thickness)}, RMS spot ${formatMicrons(previousRms)} → ${formatMicrons(rms)}.`
        : `Already at best focus: RMS spot ${formatMicrons(rms)}. Nothing moved.`) + caveat,
    );
    onChange(result.value.system);
  };

  /**
   * Makes a surface a mirror, and says what else moved.
   *
   * Turning a surface round also flips the thickness after it, because that
   * distance is measured along +Z and +Z is now behind the light. It is the
   * right thing to do — without it every ray after the mirror reports MISSED and
   * the layout simply empties — but it is a second edit the user did not type,
   * so it is reported rather than done quietly.
   */
  const mirror = (index: number): void => {
    const before = system.surfaceAt(index).thickness;
    const result = setMirror(system, index, true);
    if (!result.ok) {
      setStatus(undefined);
      setError(result.error);
      return;
    }
    setError(undefined);
    setStatus(
      `Surface ${index} is now a mirror in ${system.surfaceAt(index - 1).material.name}. ` +
        `Its thickness flipped to ${formatLength(-before)}: the light travels back the way it came.`,
    );
    onChange(result.value);
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
      <datalist id={MATERIAL_LIST_ID}>
        {/* MODEL and MIRROR lead the list because neither is a name to look
            up: one opens the Model glass column, the other makes the surface
            reflect. Everything below them is a real glass. */}
        <option value={MODEL_MATERIAL_LABEL} key={MODEL_MATERIAL_LABEL} />
        <option value={MIRROR_MATERIAL_LABEL} key={MIRROR_MATERIAL_LABEL} />
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
              {/* A header names a whole column, so it can only speak for one row
                  while the cursor is on that row. On a coordinate transform the
                  four shape columns hold nothing, and saying "Radius" over an
                  empty span is worse than saying what is actually there. */}
              {headerIsTransform ? (
                <th colSpan={SHAPE_COLUMNS} className="transform-header">
                  Coordinate Transform
                </th>
              ) : (
                <>
                  <th>Radius</th>
                  <th>Conic</th>
                  <th>Asphere</th>
                  <th>Focal length</th>
                </>
              )}
              <th>Thickness</th>
              <th>Material</th>
              <th>Model glass</th>
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
              const isTransform = surface.type === 'COORDINATE_TRANSFORM';
              const isFixed = isObject || isImage;
              const modelParameters = modelGlassText(surface.material);
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

                  {/* A coordinate transform has none of the four things these
                      columns hold — no radius, no conic, no polynomial, no focal
                      length — so on its row they become one field carrying the
                      thing it does have. The header follows suit while the cursor
                      is on the row, which is the only time a shared header can
                      honestly name one row's contents. */}
                  {isTransform ? (
                    <td colSpan={SHAPE_COLUMNS} className="transform-cell">
                      {surface.coordinateTransform !== undefined ? (
                        <CoordinateTransformSummaryButton
                          parameters={surface.coordinateTransform}
                          surfaceLabel={label}
                          onOpen={() => setTransformSurface(index)}
                        />
                      ) : null}
                    </td>
                  ) : (
                    <>
                      {/* Radius and focal length are the two ways a surface can
                          carry power, and no surface has both; the inapplicable
                          one is blank. */}
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

                      {/* Conic sits beside the radius because the two together
                          are the surface's shape: the radius is where it starts,
                          the conic is how it departs from a sphere. */}
                      <td>
                        {isParaxial ? (
                          <EmptyCell reason="A paraxial surface is a plane; it has no conic constant." />
                        ) : (
                          <NumericCell
                            value={surface.conic}
                            ariaLabel={`Conic constant of surface ${label}`}
                            title="Conic constant k. 0 sphere, −1 paraboloid, below −1 hyperboloid, between −1 and 0 ellipsoid."
                            onCommit={(next) =>
                              apply(updateSurface(system, index, { conic: next }))
                            }
                          />
                        )}
                      </td>

                      <td>
                        {surface.type === 'EVEN_ASPHERE' ? (
                          <AsphericSummaryButton
                            coefficients={surface.asphericCoefficients}
                            surfaceLabel={label}
                            onOpen={() => setAsphereSurface(index)}
                          />
                        ) : (
                          <EmptyCell reason="Set the surface type to EVEN_ASPHERE to give it aspheric coefficients." />
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
                    </>
                  )}

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
                    {/* Zemax writes "-" here for a transform, because a transform cannot
                        be a boundary between two media: it carries whatever the
                        surface before it did, and the model refuses anything
                        else. Showing a blank editable cell would invite an edit
                        that could only be rejected. */}
                    {isTransform ? (
                      <EmptyCell reason="A coordinate transform carries the medium before it; it cannot be a boundary between two media." />
                    ) : (
                      <MaterialCell
                        material={surface.material}
                        reflective={surface.reflective}
                        ariaLabel={`Material after surface ${label}`}
                        disabled={isImage || isParaxial}
                        onCommit={(material) =>
                          apply(
                            surface.reflective
                              ? // Leaving MIRROR: drop the reflection first, so the
                                // new medium is applied to a refracting surface
                                // rather than to one the model still calls a mirror.
                                chain(setMirror(system, index, false), (next) =>
                                  updateSurface(next, index, { material }),
                                )
                              : updateSurface(system, index, { material }),
                          )
                        }
                        onMirror={() => mirror(index)}
                      />
                    )}
                  </td>

                  {/* The parameters of a glass given by numbers rather than by
                      name; blank for air and for anything in the catalog. */}
                  <td>
                    {modelParameters === undefined ? (
                      <EmptyCell reason="Set the material to MODEL to give a glass by index and Abbe number." />
                    ) : (
                      <ModelGlassCell
                        text={modelParameters}
                        ariaLabel={`Model glass parameters of surface ${label}`}
                        disabled={isImage}
                        onCommit={(material) => apply(updateSurface(system, index, { material }))}
                      />
                    )}
                  </td>

                  <td>
                    {isTransform ? (
                      <EmptyCell reason="A coordinate transform meets no ray, so it has no clear aperture." />
                    ) : (
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
                    )}
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

      {asphereSurface !== undefined && system.surfaces[asphereSurface] ? (
        <AsphericCoefficientsDialog
          // Keyed on the surface so opening a different row rebuilds the dialog
          // rather than carrying the previous row's "add term" state across.
          key={system.surfaceAt(asphereSurface).id}
          surfaceLabel={String(asphereSurface)}
          coefficients={system.surfaceAt(asphereSurface).asphericCoefficients}
          onCommit={(asphericCoefficients) =>
            apply(updateSurface(system, asphereSurface, { asphericCoefficients }))
          }
          onClose={() => setAsphereSurface(undefined)}
        />
      ) : null}

      {transformSurface !== undefined &&
      system.surfaceAt(transformSurface).coordinateTransform !== undefined ? (
        <CoordinateTransformDialog
          key={system.surfaceAt(transformSurface).id}
          surfaceLabel={String(transformSurface)}
          parameters={system.surfaceAt(transformSurface).coordinateTransform!}
          onCommit={(changes) =>
            apply(updateCoordinateTransform(system, transformSurface, changes))
          }
          onClose={() => setTransformSurface(undefined)}
        />
      ) : null}
    </Panel>
  );
}

/**
 * The four columns that describe a surface's shape and power: radius, conic,
 * parameters, focal length. A coordinate transform has none of them, so on its
 * row they are spanned by the one field it does have.
 */
const SHAPE_COLUMNS = 4;

/** The types a user may pick between, in the order they appear in the dropdown. */
const EDITABLE_SURFACE_TYPES: readonly EditableSurfaceType[] = [
  'STANDARD',
  'EVEN_ASPHERE',
  'PARAXIAL',
  'COORDINATE_TRANSFORM',
];

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

/**
 * The medium after a surface: a catalog name, blank for air, or MODEL for a
 * glass given by its numbers, which the Model glass column then carries.
 * Validated as you type and committed on the way out, so a name that is not a
 * glass is shown as wrong rather than applied.
 */
function MaterialCell({
  material,
  reflective,
  ariaLabel,
  disabled,
  onCommit,
  onMirror,
}: {
  material: Material;
  reflective: boolean;
  ariaLabel: string;
  disabled: boolean;
  onCommit: (material: Material) => void;
  onMirror: () => void;
}) {
  const label = materialLabel(material, reflective);
  const [draft, setDraft] = useState(label);
  const [editing, setEditing] = useState(false);
  const shown = editing ? draft : label;
  const wantsMirror = isMirrorText(shown);
  const resolved = wantsMirror ? material : materialFromText(shown, material);

  return (
    <input
      list={MATERIAL_LIST_ID}
      value={shown}
      disabled={disabled}
      placeholder="air"
      aria-label={ariaLabel}
      className={resolved ? undefined : 'invalid'}
      title={
        resolved
          ? `A catalog glass name, blank for air, ${MODEL_MATERIAL_LABEL} for a glass given by ` +
            `index and Abbe number, or ${MIRROR_MATERIAL_LABEL} to reflect. A mirror keeps the ` +
            'medium it is in and reverses the thickness after it.'
          : `"${shown.trim()}" is not in the catalog`
      }
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => {
        setDraft(label);
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        if (isMirrorText(draft)) {
          // MIRROR is not a medium, so it does not go through onCommit: the
          // surface's medium and thickness both have to move with it.
          if (!reflective) {
            onMirror();
          }
          return;
        }
        const next = materialFromText(draft, material);
        // Compared by identity: MODEL over a model glass returns the same glass,
        // and re-committing it would put an identical design on the undo stack.
        // A surface leaving MIRROR still commits, even to the same medium, since
        // what changes there is the reflection rather than the material.
        if (next && (next !== material || reflective)) {
          onCommit(next);
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

/**
 * The parameters of a model glass — `nd / Vd`, and ΔPg,F when it has one. One
 * cell rather than three columns, because the three numbers are read and quoted
 * together, and two of them are blank on most rows of a real design.
 */
function ModelGlassCell({
  text,
  ariaLabel,
  disabled,
  onCommit,
}: {
  text: string;
  ariaLabel: string;
  disabled: boolean;
  onCommit: (material: Material) => void;
}) {
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  const shown = editing ? draft : text;
  const parsed = modelGlassFromText(shown);

  return (
    <input
      className={parsed.ok ? 'parameters' : 'parameters invalid'}
      value={shown}
      disabled={disabled}
      aria-label={ariaLabel}
      title={parsed.ok ? MODEL_GLASS_HINT : parsed.error}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => {
        setDraft(text);
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        // On the text, not the material: parsing the unchanged cell builds an
        // equal-but-distinct glass, which would re-render the whole design and
        // push an undo step for a cell the user only passed through.
        if (draft.trim() === text.trim()) {
          return;
        }
        const material = modelGlassFromText(draft);
        if (material.ok) {
          onCommit(material.value);
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
