import type { SellmeierCoefficients } from '@isaac/optical-core';

/**
 * One glass as published by its manufacturer: a dispersion fit plus the range
 * of wavelengths that fit is valid over.
 */
export interface GlassRecord {
  /** Manufacturer's name for the glass, e.g. `N-BK7`. */
  name: string;
  /** Manufacturer, e.g. `SCHOTT`. */
  manufacturer: string;
  /** The manufacturer's sub-catalog: `optical`, `infrared`, `misc`, `obsolete`. */
  catalog: string;
  /** Three-term Sellmeier coefficients (λ in µm, C in µm²). */
  coefficients: SellmeierCoefficients;
  /** Wavelength range of the published fit, in nanometers: `[min, max]`. */
  rangeNm: readonly [number, number];
}
