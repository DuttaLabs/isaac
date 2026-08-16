import { useState } from "react";
import type { OpticalSystem } from "@isaac/optical-core";
import {
  GLASS_CATALOG,
  glassName,
  resolveGlass,
} from "../lib/default-system.ts";
import {
  insertSurfaceAfter,
  normalizeRadius,
  normalizeSemiDiameter,
  removeSurface,
  setStop,
  setSurfaceType,
  updateSurface,
  type EditableSurfaceType,
} from "../lib/edits.ts";
import type { Result } from "../lib/result.ts";
import { ErrorNote, Panel } from "./Panel.tsx";
import { NumericCell } from "./NumericCell.tsx";
import { TextCell } from "./TextCell.tsx";

const GLASS_LIST_ID = "glass-names";

/**
 * The spreadsheet the design is actually edited in. Every cell edit produces a
 * new OpticalSystem; if the model rejects the change the previous system stays
 * on screen and the reason is shown under the table.
 */
export function LensDataEditor({
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

  return (
    <Panel
      title="Optical system"
      flush
      actions={
        <span className="hint">
          {system.surfaces.length} surfaces · {system.units}
        </span>
      }
    >
      <datalist id={GLASS_LIST_ID}>
        {GLASS_CATALOG.names().map((name) => (
          <option value={name} key={name} />
        ))}
      </datalist>

      <div className="table-scroll">
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
              const isObject = surface.type === "OBJECT";
              const isImage = surface.type === "IMAGE";
              const isParaxial = surface.type === "PARAXIAL";
              const isFixed = isObject || isImage;
              // Zemax names the ends of the system and the stop rather than
              // numbering them; everything else is its surface number.
              const label = isObject
                ? "OBJ"
                : isImage
                  ? "IMA"
                  : surface.isStop
                    ? "STO"
                    : String(index);

              return (
                <tr key={surface.id}>
                  <td className="row-label" title={`Surface ${index}`}>
                    {label}
                  </td>

                  <td>
                    <SurfaceTypeCell
                      type={surface.type}
                      fixed={isFixed}
                      ariaLabel={`Type of surface ${label}`}
                      onChange={(next) =>
                        apply(setSurfaceType(system, index, next))
                      }
                    />
                  </td>

                  <td className="text-column">
                    <TextCell
                      value={surface.comment ?? ""}
                      placeholder="—"
                      ariaLabel={`Label for surface ${label}`}
                      title="A note naming this surface. Imported from and written as Zemax's COMM record."
                      onCommit={(next) =>
                        apply(updateSurface(system, index, { comment: next }))
                      }
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
                      onCommit={(next) =>
                        apply(updateSurface(system, index, { thickness: next }))
                      }
                    />
                  </td>

                  <td>
                    <GlassCell
                      surfaceName={glassName(surface.material)}
                      disabled={isImage}
                      onCommit={(material) =>
                        apply(updateSurface(system, index, { material }))
                      }
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
        <div style={{ padding: "10px 12px" }}>
          <ErrorNote message={error} />
        </div>
      ) : null}
    </Panel>
  );
}

/** The types a user may pick between, in the order they appear in the dropdown. */
const EDITABLE_SURFACE_TYPES: readonly EditableSurfaceType[] = ["STANDARD", "PARAXIAL"];

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
      className={resolved ? undefined : "invalid"}
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
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
