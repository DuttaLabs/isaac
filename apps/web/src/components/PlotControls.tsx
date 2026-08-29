/**
 * The two controls every plot of traced rays carries.
 *
 * They were one pair of values on `App`, read by both layout views, back when
 * two copies of a panel were required to be indistinguishable. They are now
 * *per pane*: these say what a given picture traces, and a second Layout 2D
 * exists precisely so it can trace something different from the first. So what
 * is shared here is the control, not the value — each panel passes its own.
 */

interface RaysProps {
  value: number;
  onChange: (value: number) => void;
}

/** How many rays across a fan, or across the pupil grid derived from it. */
export function RaysControl({ value, onChange }: RaysProps) {
  return (
    <label className="inline hint" title="How many rays across the pupil this plot traces">
      rays
      <input
        type="number"
        min={1}
        max={31}
        step={2}
        value={value}
        style={{ width: 56 }}
        onChange={(event) => onChange(Math.max(1, Math.min(31, Number(event.target.value) || 1)))}
      />
    </label>
  );
}

interface WavelengthsProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

/** Every wavelength, or the primary one on its own. */
export function WavelengthsControl({ value, onChange }: WavelengthsProps) {
  return (
    <label className="inline hint" title="Trace every wavelength, not the primary one alone">
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      all wavelengths
    </label>
  );
}
