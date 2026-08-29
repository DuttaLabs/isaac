import type { OpticalSystem } from '@isaac/optical-core';
import { fieldLabel } from '../lib/fields.ts';

/**
 * Which field a single-field plot is taken at.
 *
 * Shared by the plots that answer a question about *one* field rather than
 * drawing several at once, so the wording and the empty-system case are settled
 * in one place. The layouts do not use it — they draw a set, and narrow it with
 * `PlotFieldFilter` instead.
 */

interface Props {
  system: OpticalSystem;
  value: number;
  onChange: (index: number) => void;
}

export function FieldChoice({ system, value, onChange }: Props) {
  return (
    <label className="inline hint" title="Which field this plot is taken at">
      field
      <select
        value={value}
        aria-label="Field"
        onChange={(event) => onChange(Number(event.target.value))}
        disabled={system.fields.length === 0}
      >
        {(system.fields.length > 0 ? system.fields : [undefined]).map((field, index) => (
          <option value={index} key={index}>
            {fieldLabel(field)}
          </option>
        ))}
      </select>
    </label>
  );
}
