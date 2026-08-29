import { useState } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { fieldStyle } from '../lib/fields.ts';
import { fieldShown, withFieldShown, type FieldFlags } from '../lib/panel-settings.ts';

/**
 * Which fields *this* plot draws, laid over the drawing's top-left corner.
 *
 * There are two levels of this and they answer different questions. The Source
 * panel's Display column says which fields are in play at all — a system-wide
 * statement, mirrored by every copy of that panel because there is one design.
 * This narrows that list for one picture, so two Layout panels side by side can
 * show one field each and be read against each other.
 *
 * Top-left because the orientation gizmo has the top-right in both views, and
 * the corner opposite it is the one place a lens layout reliably has room:
 * the drawing is wide and centered on an axis running across the middle.
 *
 * **Collapsed by default**, unlike the gizmo beside it, and for a reason the
 * gizmo shows: that one takes no pointer events, because the corner of a picture
 * is as good a place as any to start a drag. A checkbox cannot ignore the
 * pointer, so an open list would eat every drag begun in that corner. Shut, it
 * is a stamp; open, it is only in the way while it is being used.
 *
 * A field switched off in Source is **ghosted here rather than dropped**, the
 * same rule the context menus follow: a list whose entries come and go teaches
 * nobody what it can do, and the row that vanished is the one being looked for.
 */

interface Props {
  system: OpticalSystem;
  /** The Source panel's flags: which fields this one is allowed to draw. */
  sourceFields: readonly boolean[];
  fields: FieldFlags;
  onChange: (fields: FieldFlags) => void;
}

export function PlotFieldFilter({ system, sourceFields, fields, onChange }: Props) {
  const [open, setOpen] = useState(false);

  if (system.fields.length === 0) {
    return null;
  }

  const available = system.fields.map((_, index) => sourceFields[index] ?? true);
  const drawn = available.filter((yes, index) => yes && fieldShown(fields, index)).length;
  const total = available.filter(Boolean).length;

  return (
    <div className="plot-filter">
      <button
        className="plot-filter-toggle"
        aria-expanded={open}
        onClick={() => setOpen((showing) => !showing)}
        title="Which fields this plot draws, within the ones the Source panel has switched on"
      >
        Fields {drawn}/{total}
      </button>
      {open ? (
        <ul className="plot-filter-list">
          {system.fields.map((field, index) => {
            const style = fieldStyle(field, index);
            const inPlay = available[index] ?? true;
            return (
              <li key={index}>
                <label
                  className={inPlay ? undefined : 'plot-filter-off'}
                  title={
                    inPlay
                      ? undefined
                      : 'Switched off for the whole system in the Source object panel'
                  }
                >
                  <input
                    type="checkbox"
                    checked={inPlay && fieldShown(fields, index)}
                    disabled={!inPlay}
                    onChange={(event) =>
                      onChange(withFieldShown(fields, index, event.target.checked))
                    }
                  />
                  <span className="plot-filter-swatch" style={{ background: style.color }} />
                  {style.label}
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
