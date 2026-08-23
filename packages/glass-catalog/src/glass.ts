import { dispersionMaterial, type Material } from '@isaac/optical-core';
import type { GlassRecord } from './types.ts';

/** Fraunhofer lines used for the Abbe number. */
export const D_LINE_NM = 587.5618; // helium d
export const F_LINE_NM = 486.1327; // hydrogen F
export const C_LINE_NM = 656.2725; // hydrogen C

export interface GlassMaterialOptions {
  /**
   * When true (the default), asking for an index outside the published fit
   * range throws instead of extrapolating. A dispersion fit is only meaningful
   * over the range it was fitted to; far outside it the numbers look plausible
   * but are meaningless — and the Schott formula, being a power series with no
   * poles, misbehaves more quietly out there than a Sellmeier fit does.
   */
  strictRange?: boolean;
}

/**
 * A catalog glass as an optical-core {@link Material}: the manufacturer's
 * dispersion fit, plus the metadata needed to know when to trust it. Which
 * equation that fit belongs to comes from the record, not from an assumption —
 * SCHOTT's catalog is nearly all Sellmeier, but not entirely.
 */
export class GlassMaterial implements Material {
  public readonly name: string;
  public readonly record: GlassRecord;
  private readonly dispersion: Material;
  private readonly strictRange: boolean;

  public constructor(record: GlassRecord, options: GlassMaterialOptions = {}) {
    this.record = record;
    this.name = record.name;
    this.dispersion = dispersionMaterial(record.name, record.formula, record.coefficients);
    this.strictRange = options.strictRange ?? true;
  }

  public indexAt(wavelengthNm: number): number {
    if (this.strictRange && !this.isWithinRange(wavelengthNm)) {
      const [min, max] = this.record.rangeNm;
      throw new RangeError(
        `${this.name}: ${wavelengthNm} nm is outside the published fit range ${min}–${max} nm. ` +
          'Pass { strictRange: false } to extrapolate anyway.',
      );
    }
    return this.dispersion.indexAt(wavelengthNm);
  }

  /** True when the wavelength lies inside the published fit range. */
  public isWithinRange(wavelengthNm: number): boolean {
    const [min, max] = this.record.rangeNm;
    return wavelengthNm >= min && wavelengthNm <= max;
  }

  /** Returns a copy with different options (e.g. to allow extrapolation). */
  public with(options: GlassMaterialOptions): GlassMaterial {
    return new GlassMaterial(this.record, { strictRange: this.strictRange, ...options });
  }

  /**
   * Refractive index at the helium d-line, computed from the fit. The catalog
   * also *prints* an nd, available as `record.nd`; the two agree to better than
   * 5e-5 for every glass, which the generator checks before writing the file.
   */
  public get nd(): number {
    this.requireVisibleFit('nd');
    return this.dispersion.indexAt(D_LINE_NM);
  }

  /** Abbe number vd = (nd − 1) / (nF − nC), computed from the fit. */
  public get abbeNumber(): number {
    this.requireVisibleFit('the Abbe number');
    const nd = this.dispersion.indexAt(D_LINE_NM);
    const nF = this.dispersion.indexAt(F_LINE_NM);
    const nC = this.dispersion.indexAt(C_LINE_NM);
    return (nd - 1) / (nF - nC);
  }

  private requireVisibleFit(quantity: string): void {
    if (!this.isWithinRange(F_LINE_NM) || !this.isWithinRange(C_LINE_NM)) {
      const [min, max] = this.record.rangeNm;
      throw new RangeError(
        `${this.name}: ${quantity} needs the F and C lines, which fall outside its fit range ${min}–${max} nm.`,
      );
    }
  }
}
