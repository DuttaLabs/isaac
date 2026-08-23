import type { OpticalSystem } from '@isaac/optical-core';
import { wavelengthStyle } from '../lib/wavelengths.ts';

/**
 * Always on screen when more than one wavelength is traced: color alone does
 * not distinguish the series for a color-blind reader, so the swatch repeats
 * the dash pattern and the label carries the wavelength.
 *
 * `pattern` drops the color and shows the dash alone. The layout colors its rays
 * by *field*, so a colored swatch there would claim a mapping that is not on
 * screen; the dash is the cue wavelength actually carries in that view.
 */
export function WavelengthLegend({
  system,
  pattern = false,
}: {
  system: OpticalSystem;
  pattern?: boolean;
}) {
  if (system.wavelengthsNm.length < 2) {
    return null;
  }
  return (
    <div className="legend">
      {system.wavelengthsNm.map((wavelengthNm, index) => {
        const style = wavelengthStyle(wavelengthNm, index);
        const primary = index === system.primaryWavelengthIndex;
        return (
          <span className="legend-item" key={`${wavelengthNm}-${index}`}>
            <svg width="22" height="10" aria-hidden="true">
              <line
                x1="1"
                y1="5"
                x2="21"
                y2="5"
                stroke={pattern ? 'var(--text-muted)' : style.color}
                strokeWidth="2"
                strokeDasharray={style.dash}
              />
            </svg>
            {style.label}
            {primary ? ' (primary)' : ''}
          </span>
        );
      })}
    </div>
  );
}
