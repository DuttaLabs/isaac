/**
 * A material is anything that can report a refractive index at a wavelength.
 * The engine only ever asks for `indexAt`, so glasses, air, and vacuum all
 * share one tiny interface. Dispersion models can be added without touching
 * the tracer.
 */
export interface Material {
  readonly name: string;
  /** Refractive index at the given wavelength (nanometres). */
  indexAt(wavelengthNm: number): number;
}

/** A non-dispersive material with a single, fixed refractive index. */
export class ConstantMaterial implements Material {
  public readonly name: string;
  private readonly index: number;

  public constructor(name: string, index: number) {
    if (!Number.isFinite(index) || index <= 0) {
      throw new RangeError('Refractive index must be a positive, finite number.');
    }
    this.name = name;
    this.index = index;
  }

  public indexAt(_wavelengthNm: number): number {
    return this.index;
  }
}

/** Three-term Sellmeier coefficients (wavelength in micrometres). */
export interface SellmeierCoefficients {
  b1: number;
  b2: number;
  b3: number;
  c1: number;
  c2: number;
  c3: number;
}

/**
 * A dispersive material described by the three-term Sellmeier equation:
 *
 *   n(λ)² = 1 + Σ Bᵢ λ² / (λ² − Cᵢ),   λ in micrometres.
 */
export class SellmeierMaterial implements Material {
  public readonly name: string;
  private readonly coefficients: SellmeierCoefficients;

  public constructor(name: string, coefficients: SellmeierCoefficients) {
    this.name = name;
    this.coefficients = coefficients;
  }

  public indexAt(wavelengthNm: number): number {
    if (!Number.isFinite(wavelengthNm) || wavelengthNm <= 0) {
      throw new RangeError('wavelengthNm must be a positive, finite number.');
    }
    const l2 = (wavelengthNm / 1000) ** 2; // micrometres, squared
    const { b1, b2, b3, c1, c2, c3 } = this.coefficients;
    const nSquared =
      1 + (b1 * l2) / (l2 - c1) + (b2 * l2) / (l2 - c2) + (b3 * l2) / (l2 - c3);
    if (!(nSquared > 0)) {
      throw new RangeError(`Sellmeier model produced a non-physical index for ${this.name}.`);
    }
    return Math.sqrt(nSquared);
  }
}

/** Air, treated as index 1 (an idealisation adequate for the current milestone). */
export const AIR: Material = new ConstantMaterial('AIR', 1);

/** Vacuum. */
export const VACUUM: Material = new ConstantMaterial('VACUUM', 1);

/** Schott N-BK7 borosilicate crown glass (measured Sellmeier coefficients). */
export const N_BK7: Material = new SellmeierMaterial('N-BK7', {
  b1: 1.03961212,
  b2: 0.231792344,
  b3: 1.01046945,
  c1: 0.00600069867,
  c2: 0.0200179144,
  c3: 103.560653,
});

/** Convenience lookup for the small set of built-in materials, keyed by name. */
export const MATERIAL_CATALOG: ReadonlyMap<string, Material> = new Map(
  [AIR, VACUUM, N_BK7].map((material) => [material.name, material]),
);
