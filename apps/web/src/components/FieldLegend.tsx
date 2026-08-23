import type { OpticalSystem } from '@isaac/optical-core';
import { fieldStyle, FIELD_COLOR_VARIABLES } from '../lib/fields.ts';

/**
 * Names the field each color in the layout belongs to.
 *
 * Always on screen once more than one field is drawn: the hues are validated
 * apart, but two of the six sit in the band where colorblind separation is only
 * good enough *with* a second cue, and this is that cue. A single field needs no
 * legend — there is nothing to tell it from.
 *
 * Only the fields actually being drawn are listed, but each keeps the color its
 * position in the system gives it, so switching one off with the Display
 * checkboxes never repaints the rest.
 */
export function FieldLegend({
  system,
  fieldIndices,
}: {
  system: OpticalSystem;
  fieldIndices: readonly number[];
}) {
  if (fieldIndices.length < 2) {
    return null;
  }

  const named = fieldIndices.filter((index) => index < FIELD_COLOR_VARIABLES.length);
  const overflow = fieldIndices.filter((index) => index >= FIELD_COLOR_VARIABLES.length);

  return (
    <div className="legend">
      {named.map((index) => {
        const style = fieldStyle(system.fields[index], index);
        return (
          <span className="legend-item" key={index}>
            <svg width="22" height="10" aria-hidden="true">
              <line x1="1" y1="5" x2="21" y2="5" stroke={style.color} strokeWidth="2" />
            </svg>
            {style.label}
          </span>
        );
      })}
      {overflow.length > 0 ? (
        <span
          className="legend-item"
          title="More fields than there are colors to give them. A repeated hue would say two fields are the same, so the rest share one neutral."
        >
          <svg width="22" height="10" aria-hidden="true">
            <line
              x1="1"
              y1="5"
              x2="21"
              y2="5"
              stroke={fieldStyle(undefined, FIELD_COLOR_VARIABLES.length).color}
              strokeWidth="2"
            />
          </svg>
          {overflow.length} further field{overflow.length > 1 ? 's' : ''}
        </span>
      ) : null}
    </div>
  );
}
