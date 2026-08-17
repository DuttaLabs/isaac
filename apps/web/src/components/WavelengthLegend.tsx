import type { OpticalSystem } from '@isaac/optical-core';
import { wavelengthStyle } from '../lib/wavelengths.ts';

/**
 * Always on screen when more than one wavelength is traced: color alone does
 * not distinguish the series for a color-blind reader, so the swatch repeats
 * the dash pattern and the label carries the wavelength.
 */
export function WavelengthLegend({ system }: { system: OpticalSystem }) {
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
                stroke={style.color}
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
