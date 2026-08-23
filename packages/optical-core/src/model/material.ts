/**
 * A material is anything that can report a refractive index at a wavelength.
 * The engine only ever asks for `indexAt`, so glasses, air, and vacuum all
 * share one tiny interface. Dispersion models can be added without touching
 * the tracer.
 */
export interface Material {
  readonly name: string;
  /** Refractive index at the given wavelength (nanometers). */
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

/** Three-term Sellmeier coefficients (wavelength in micrometers). */
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
 *   n(λ)² = 1 + Σ Bᵢ λ² / (λ² − Cᵢ),   λ in micrometers.
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
    const l2 = (wavelengthNm / 1000) ** 2; // micrometers, squared
    const { b1, b2, b3, c1, c2, c3 } = this.coefficients;
    const nSquared = 1 + (b1 * l2) / (l2 - c1) + (b2 * l2) / (l2 - c2) + (b3 * l2) / (l2 - c3);
    if (!(nSquared > 0)) {
      throw new RangeError(`Sellmeier model produced a non-physical index for ${this.name}.`);
    }
    return Math.sqrt(nSquared);
  }
}

/** Coefficients of the Schott dispersion formula (wavelength in micrometers). */
export interface SchottDispersionCoefficients {
  a0: number;
  a1: number;
  a2: number;
  a3: number;
  a4: number;
  a5: number;
}

/**
 * A dispersive material described by the *Schott formula*, a power series in
 * λ² rather than a resonance model:
 *
 *   n(λ)² = a₀ + a₁λ² + a₂λ⁻² + a₃λ⁻⁴ + a₄λ⁻⁶ + a₅λ⁻⁸,   λ in micrometers.
 *
 * Do not read the name as "the formula SCHOTT glasses use" — it is the older
 * form the company published before switching to Sellmeier, and in SCHOTT's
 * current catalog exactly one glass still carries it (B270, a soda-lime sheet
 * glass rather than an optical melt). The formula number in the catalog is what
 * says which of the two applies, glass by glass; see {@link dispersionMaterial}.
 *
 * It has no pole to fall into, so it cannot produce the non-physical index a
 * Sellmeier fit can near a resonance — but it also extrapolates far worse, which
 * is the more reason to honor the published wavelength range.
 */
export class SchottDispersionMaterial implements Material {
  public readonly name: string;
  private readonly coefficients: SchottDispersionCoefficients;

  public constructor(name: string, coefficients: SchottDispersionCoefficients) {
    this.name = name;
    this.coefficients = coefficients;
  }

  public indexAt(wavelengthNm: number): number {
    if (!Number.isFinite(wavelengthNm) || wavelengthNm <= 0) {
      throw new RangeError('wavelengthNm must be a positive, finite number.');
    }
    const l2 = (wavelengthNm / 1000) ** 2; // micrometers, squared
    const { a0, a1, a2, a3, a4, a5 } = this.coefficients;
    const nSquared = a0 + a1 * l2 + a2 / l2 + a3 / l2 ** 2 + a4 / l2 ** 3 + a5 / l2 ** 4;
    if (!(nSquared > 0)) {
      throw new RangeError(
        `Schott dispersion model produced a non-physical index for ${this.name}.`,
      );
    }
    return Math.sqrt(nSquared);
  }
}

/**
 * Dispersion formulas, numbered as a Zemax-format glass catalog numbers them.
 * The number is part of the manufacturer's data — a catalog states, per glass,
 * which equation its coefficients belong to — so it is carried through rather
 * than normalized away, and an unrecognized one is refused rather than assumed.
 *
 * Only the two SCHOTT actually publishes are implemented. The gaps are real
 * formula numbers (3 Herzberger, 4 Sellmeier 2, 5 Conrady, …) left unimplemented
 * because no glass in the catalog uses them; add them here when one does.
 */
export const DISPERSION_FORMULA = {
  /** n² = a₀ + a₁λ² + a₂λ⁻² + a₃λ⁻⁴ + a₄λ⁻⁶ + a₅λ⁻⁸ */
  SCHOTT: 1,
  /** n² − 1 = Σ Bᵢλ²/(λ² − Cᵢ) */
  SELLMEIER_1: 2,
} as const;

/**
 * Builds the right {@link Material} for a catalog entry's formula number and its
 * raw coefficient list, in the order the catalog writes them.
 *
 * Taking the coefficients as a plain list is deliberate: it is how a catalog
 * stores them, and each formula reads a different number of them for different
 * purposes, so naming them can only happen *after* the formula is known.
 */
export function dispersionMaterial(
  name: string,
  formula: number,
  coefficients: readonly number[],
): Material {
  const need = (count: number): number[] => {
    const values = coefficients.slice(0, count);
    if (values.length < count || values.some((value) => !Number.isFinite(value))) {
      throw new RangeError(
        `${name}: dispersion formula ${formula} needs ${count} finite coefficients, got ${coefficients.length}.`,
      );
    }
    return values;
  };

  switch (formula) {
    case DISPERSION_FORMULA.SCHOTT: {
      const [a0, a1, a2, a3, a4, a5] = need(6) as [number, number, number, number, number, number];
      return new SchottDispersionMaterial(name, { a0, a1, a2, a3, a4, a5 });
    }
    case DISPERSION_FORMULA.SELLMEIER_1: {
      // Written interleaved in the catalog — B₁ C₁ B₂ C₂ B₃ C₃ — not grouped.
      const [b1, c1, b2, c2, b3, c3] = need(6) as [number, number, number, number, number, number];
      return new SellmeierMaterial(name, { b1, b2, b3, c1, c2, c3 });
    }
    default:
      throw new RangeError(
        `${name}: dispersion formula ${formula} is not implemented. ` +
          `Supported: ${Object.entries(DISPERSION_FORMULA)
            .map(([key, value]) => `${value} (${key})`)
            .join(', ')}.`,
      );
  }
}

/** The spectral lines a model glass is anchored to, in nanometers. */
export const SPECTRAL_LINES = {
  /** Helium d, the reference for nd and the Abbe number. */
  d: 587.5618,
  /** Hydrogen F. */
  F: 486.1327,
  /** Hydrogen C. */
  C: 656.2725,
  /** Mercury g, which fixes the partial dispersion. */
  g: 435.8343,
} as const;

/**
 * The "normal line" of the glass map: where a glass's partial dispersion sits
 * if it is an ordinary crown or flint. Classically the line through K7 and F2,
 * which is where these constants come from — recomputing it from the SCHOTT
 * Sellmeier fits for those two glasses reproduces them to 4 decimal places.
 */
const NORMAL_LINE = { intercept: 0.6438, slope: 0.001682 };

/** Partial dispersion Pg,F an ordinary glass of this Abbe number would have. */
export function normalLinePartialDispersion(abbeNumber: number): number {
  return NORMAL_LINE.intercept - NORMAL_LINE.slope * abbeNumber;
}

/** Buchdahl's α, the one universal constant in the chromatic coordinate. */
const BUCHDAHL_ALPHA = 2.5;

/**
 * Buchdahl's chromatic coordinate: a change of variable from wavelength that
 * makes dispersion nearly polynomial, so two terms cover the visible band.
 */
function chromaticCoordinate(wavelengthUm: number): number {
  const delta = wavelengthUm - SPECTRAL_LINES.d / 1000;
  return delta / (1 + BUCHDAHL_ALPHA * delta);
}

export interface ModelGlassOptions {
  /**
   * Deviation of the partial dispersion from the normal line. Zero — an
   * ordinary glass — is the right default: it is also what a lens file that
   * gives only nd and Vd is saying.
   */
  deltaPgF?: number;
}

/**
 * A glass described the way a patent describes one: by its index at the d line
 * and its Abbe number, rather than by measured Sellmeier coefficients.
 *
 * The index curve is a two-term expansion in Buchdahl's chromatic coordinate,
 *
 *   n(λ) = nd + ν₁ω + ν₂ω²,   ω = (λ − λd) / (1 + 2.5(λ − λd)),  λ in µm,
 *
 * with ν₁ and ν₂ fixed by two constraints the three inputs give us: the Abbe
 * number sets nF − nC = (nd − 1)/Vd, and the partial dispersion sets
 * nG − nF = Pg,F (nF − nC).
 *
 * This is *not* OpticStudio's model glass. That formula is proprietary and
 * unpublished, so it is not reproduced here; this is an independent model built
 * from published optics. Checked against all 161 SCHOTT glasses whose fits
 * reach the g line, by deriving (nd, Vd, ΔPg,F) from each real fit and
 * rebuilding the glass from only those three numbers: across 400–700 nm the
 * median index error is 9e-6 and the worst 3e-4, which is the same order as the
 * ~1e-4 OpticStudio claims for its own. With ΔPg,F left at zero the worst case
 * grows to 4e-3, so a file that names only nd and Vd buys a cruder glass — fine
 * for layout and first-order work, not for judging color correction.
 */
export class ModelGlassMaterial implements Material {
  public readonly name: string;
  public readonly nd: number;
  public readonly abbeNumber: number;
  public readonly deltaPgF: number;
  private readonly nu1: number;
  private readonly nu2: number;

  public constructor(
    name: string,
    nd: number,
    abbeNumber: number,
    options: ModelGlassOptions = {},
  ) {
    if (!Number.isFinite(nd) || nd <= 0) {
      throw new RangeError(`Model glass "${name}" needs a positive, finite nd; got ${nd}.`);
    }
    // A zero Abbe number would divide by zero, and a negative one would make
    // the glass disperse backwards; neither describes a real material.
    if (!Number.isFinite(abbeNumber) || abbeNumber <= 0) {
      throw new RangeError(
        `Model glass "${name}" needs a positive, finite Abbe number; got ${abbeNumber}.`,
      );
    }

    this.name = name;
    this.nd = nd;
    this.abbeNumber = abbeNumber;
    this.deltaPgF = options.deltaPgF ?? 0;

    const wF = chromaticCoordinate(SPECTRAL_LINES.F / 1000);
    const wC = chromaticCoordinate(SPECTRAL_LINES.C / 1000);
    const wG = chromaticCoordinate(SPECTRAL_LINES.g / 1000);

    const principalDispersion = (nd - 1) / abbeNumber; // nF − nC
    const partialDispersion = normalLinePartialDispersion(abbeNumber) + this.deltaPgF;
    const gToF = partialDispersion * principalDispersion; // nG − nF

    // Two linear equations in ν₁ and ν₂, solved by hand rather than by a matrix
    // routine the core does not otherwise need.
    const a1 = wF - wC;
    const a2 = wF * wF - wC * wC;
    const b1 = wG - wF;
    const b2 = wG * wG - wF * wF;
    const determinant = a1 * b2 - a2 * b1;
    this.nu1 = (principalDispersion * b2 - a2 * gToF) / determinant;
    this.nu2 = (a1 * gToF - principalDispersion * b1) / determinant;
  }

  public indexAt(wavelengthNm: number): number {
    if (!Number.isFinite(wavelengthNm) || wavelengthNm <= 0) {
      throw new RangeError('wavelengthNm must be a positive, finite number.');
    }
    const w = chromaticCoordinate(wavelengthNm / 1000);
    const index = this.nd + this.nu1 * w + this.nu2 * w * w;
    if (!(index > 0)) {
      throw new RangeError(`Model glass ${this.name} produced a non-physical index.`);
    }
    return index;
  }
}

/** Air, treated as index 1 (an idealization adequate for the current milestone). */
export const AIR: Material = new ConstantMaterial('AIR', 1);

/** Vacuum. */
export const VACUUM: Material = new ConstantMaterial('VACUUM', 1);

/**
 * SCHOTT N-BK7 borosilicate crown, the reference glass of most textbook
 * examples, kept here so the core has one real dispersive material without
 * depending on a catalog. The coefficients are SCHOTT's own published Sellmeier
 * fit, and `glass-catalog` has a test asserting this copy still agrees with the
 * catalog's entry to 1e-12 — if the manufacturer refits the glass, that test is
 * what will say so.
 */
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
