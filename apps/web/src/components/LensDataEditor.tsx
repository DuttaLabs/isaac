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
  updateSurface,
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
              <th className="text-column">Label</th>
              <th>Radius</th>
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
              const label = isObject ? "OBJ" : isImage ? "IMG" : String(index);

              return (
                <tr key={surface.id}>
                  <td className="row-label">{label}</td>

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

                  <td>
                    <NumericCell
                      value={surface.radius}
                      ariaLabel={`Radius of surface ${label}`}
                      title="Radius of curvature. 0 or blank means flat."
                      disabled={isObject || isImage}
                      onCommit={(next) =>
                        apply(
                          updateSurface(system, index, {
                            radius: normalizeRadius(next),
                          }),
                        )
                      }
                    />
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
                      disabled={surface.type !== "STANDARD"}
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
                      disabled={surface.type !== "STANDARD"}
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
