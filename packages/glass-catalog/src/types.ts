/**
 * One glass exactly as its manufacturer publishes it in a Zemax-format catalog
 * (`.AGF`): the dispersion fit, which equation that fit belongs to, and the
 * range it is valid over.
 *
 * The catalog is reproduced as written, duplicates included — `BK7` and `N-BK7`
 * are separate entries even though their optical fits are identical, because
 * they are separate products and only their *optical* properties coincide.
 * Mechanical data that differs between them (thermal expansion, density,
 * chemical resistance) is in the same records and can be carried here later.
 */
export interface GlassRecord {
  /** Manufacturer's name for the glass, e.g. `N-BK7`. */
  name: string;
  /** Manufacturer, e.g. `SCHOTT`. */
  manufacturer: string;
  /**
   * Which dispersion equation {@link coefficients} belongs to, numbered as the
   * catalog numbers it — see `DISPERSION_FORMULA` in `optical-core`. Carried per
   * glass because it varies per glass: SCHOTT's catalog is almost entirely
   * Sellmeier 1 (2), with B270 on the older Schott formula (1).
   */
  formula: number;
  /**
   * The fit's coefficients, in the order the catalog writes them. Left as a
   * plain list because their meaning depends on {@link formula} — for Sellmeier
   * they are interleaved `B₁ C₁ B₂ C₂ B₃ C₃`, for the Schott formula they are
   * `a₀ … a₅`. `dispersionMaterial()` names them once the formula is known.
   */
  coefficients: readonly number[];
  /** Wavelength range of the published fit, in nanometers: `[min, max]`. */
  rangeNm: readonly [number, number];
  /**
   * The manufacturer's own `nd` and Abbe number, as printed in the catalog
   * rather than computed from the fit. Kept because they are the datasheet
   * values a designer quotes, and because recomputing them from the fit and
   * comparing is the check that the fit was transcribed correctly.
   */
  nd: number;
  abbeNumber: number;
  /**
   * The catalog's status for this glass — see {@link GLASS_STATUS}. Obsolete
   * entries are kept: a lens file from 1985 names them, and refusing to open it
   * helps nobody. The UI should rank an available glass above a discontinued one.
   */
  status: GlassStatus;
}

/**
 * Status codes a Zemax-format catalog gives a glass, in the order the
 * OpticStudio manual lists them: Standard, Preferred, Obsolete, Special, Melt.
 * The manual also warns that "the status classification may differ slightly
 * between vendors", so treat it as the maker's shelf-availability hint rather
 * than a hard fact — SCHOTT uses 1–3, Ohara 0–2.
 *
 * `MELT` marks a glass fitted from melt data inside OpticStudio rather than
 * published by the manufacturer. None appears in a vendor file, but the code is
 * listed here so encountering one is recognized rather than refused.
 */
export const GLASS_STATUS = {
  0: 'STANDARD',
  1: 'PREFERRED',
  2: 'OBSOLETE',
  3: 'SPECIAL',
  4: 'MELT',
} as const;

export type GlassStatus = (typeof GLASS_STATUS)[keyof typeof GLASS_STATUS];
