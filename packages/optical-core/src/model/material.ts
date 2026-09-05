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

/** Coefficients of the Conrady dispersion formula (wavelength in micrometers). */
export interface ConradyCoefficients {
  n0: number;
  a: number;
  b: number;
}

/**
 * `n = n₀ + A/λ + B/λ^3.5`, with λ in micrometers.
 *
 * The odd one out among the classical fits: every other formula here is a series
 * in λ² and so is even in λ, while this is a three-parameter fit in λ itself with
 * a fractional power. It is what an old catalog carries when a glass was
 * characterized from three measured lines and nothing more — three coefficients
 * for three measurements — which is why it turns up on obsolete glasses and on
 * materials measured once in the literature rather than on current production.
 *
 * The `3.5` is not a typo and not an approximation of 4: it is Conrady's own
 * exponent, fitted empirically to the shape of a normal glass's dispersion curve.
 */
export class ConradyMaterial implements Material {
  public readonly name: string;
  private readonly coefficients: ConradyCoefficients;

  public constructor(name: string, coefficients: ConradyCoefficients) {
    this.name = name;
    this.coefficients = coefficients;
  }

  public indexAt(wavelengthNm: number): number {
    if (!Number.isFinite(wavelengthNm) || wavelengthNm <= 0) {
      throw new RangeError('wavelengthNm must be a positive, finite number.');
    }
    const l = wavelengthNm / 1000; // micrometers
    const { n0, a, b } = this.coefficients;
    const n = n0 + a / l + b / l ** 3.5;
    if (!(n > 0)) {
      throw new RangeError(`Conrady model produced a non-physical index for ${this.name}.`);
    }
    return n;
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
 * The gaps are real formula numbers (3 Herzberger, 4 Sellmeier 2, 6 Sellmeier 3,
 * …) left unimplemented because no glass in a catalog this repo reads uses them;
 * add them here when one does.
 */
export const DISPERSION_FORMULA = {
  /** n² = a₀ + a₁λ² + a₂λ⁻² + a₃λ⁻⁴ + a₄λ⁻⁶ + a₅λ⁻⁸ */
  SCHOTT: 1,
  /** n² − 1 = Σ Bᵢλ²/(λ² − Cᵢ) */
  SELLMEIER_1: 2,
  /** n = n₀ + A/λ + B/λ^3.5 */
  CONRADY: 5,
} as const;

/**
 * How many coefficients each formula reads.
 *
 * Published so that a catalog reader can tell a formula's **zero term** from the
 * catalog's **zero padding**, which look identical in the file: an `.AGF` writes
 * ten slots whatever the fit needs, and a two-term Sellmeier is six meaningful
 * numbers of which the last two are zeros that matter.
 */
export const DISPERSION_COEFFICIENT_COUNT: Readonly<Record<number, number>> = {
  [DISPERSION_FORMULA.SCHOTT]: 6,
  [DISPERSION_FORMULA.SELLMEIER_1]: 6,
  [DISPERSION_FORMULA.CONRADY]: 3,
};

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
    case DISPERSION_FORMULA.CONRADY: {
      const [n0, a, b] = need(3) as [number, number, number];
      return new ConradyMaterial(name, { n0, a, b });
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

/**
 * A medium a lens sits *in* rather than one a lens is made *of*.
 *
 * The model has no notion of an element: a lens is *implied* by a surface whose
 * following medium is not air, so anything with an index other than 1 reads as a
 * piece of glass. That is wrong for a fluid, and the picture it produces is a
 * singlet immersed in water counted as a cemented doublet — one element spanning
 * three rows, two swatches, an "L1" that is half lens and half tank.
 *
 * The distinction is not about index and could not be: seawater is 1.340 and
 * immersion oil is 1.515, squarely inside the range of real glasses. It is about
 * **whether the medium has a figure of its own**. A lens is a thing you can pick
 * up, and its two faces are surfaces someone ground; a fluid takes the shape of
 * whatever contains it, so its "faces" belong to the glass and the detector on
 * either side of it. Air and vacuum are the same statement at index 1, which is
 * why they never needed saying.
 *
 * The list is a closed one, and every entry is a record in the `MISC` catalog —
 * where the materials that are not anybody's *product* live. `glass-catalog`'s
 * `fluids.test.ts` pins these numbers against that catalog, so a regeneration
 * that moved one would fail rather than quietly stop recognizing it.
 */
export interface FluidMedium {
  /** The catalog's own name for it. */
  readonly name: string;
  /** Index at the d line, as the catalog prints it. */
  readonly nd: number;
  /** Abbe number, as the catalog prints it. */
  readonly abbeNumber: number;
}

export const FLUID_MEDIA: readonly FluidMedium[] = [
  { name: 'WATER', nd: 1.333044, abbeNumber: 55.794322 },
  { name: 'SEAWATER', nd: 1.339529, abbeNumber: 57.917652 },
  // Cargille Type A immersion liquid, nd 1.5150 — the index-matching oil a
  // microscope objective is coupled to its coverslip with.
  { name: 'TYPEA', nd: 1.51509, abbeNumber: 41.585023 },
  // Not a fluid at all, but the same statement: nothing to make a lens from.
  // The catalog's entry is 0.999728 rather than exactly 1, which is enough to
  // read as glass without this.
  { name: 'VACUUM', nd: 0.999728, abbeNumber: 89.195538 },
];

/**
 * How close a model glass has to be to a fluid's published numbers to *be* that
 * fluid.
 *
 * Deliberately tight. The nearest solid in every catalog Isaac carries is 0.033
 * away from Type A oil in nd and 0.126 away from seawater, so this is an
 * identification with more than an order of magnitude of margin, not a nearest
 * match — and `fluids.test.ts` asserts that margin rather than assuming it, so a
 * future catalog entry that collided would stop somebody and make them look.
 */
const FLUID_TOLERANCE = { nd: 1e-3, abbeNumber: 0.5 } as const;

/** Case and separators are spelling; `SEA_WATER` and `SEAWATER` are one name. */
function normalizeMediumName(name: string): string {
  return name.toUpperCase().replace(/[\s_-]/g, '');
}

/**
 * Which fluid this medium is, if it is one.
 *
 * Two ways a lens file names one, and both are in the corpus. Most write the
 * catalog's name — `GLAS WATER` on the last surface of an immersion lithography
 * objective, with the wafer as the image plane. But a design taken from a paper
 * carries no glass names at all, only indices: `Liang2002a.zmx` writes the eye's
 * vitreous humour as a **model glass** at 1.33304403094 / 55.7943215, which is
 * `MISC`'s WATER to every digit that catalog prints.
 *
 * So a model glass — a glass with no name, described by its numbers — is matched
 * on those numbers. **A glass that has a name is taken at its name**, and never
 * reinterpreted, which is what keeps a real melt from being mistaken for oil.
 */
export function fluidMedium(material: Material): FluidMedium | undefined {
  const named = normalizeMediumName(material.name);
  const byName = FLUID_MEDIA.find((fluid) => normalizeMediumName(fluid.name) === named);
  if (byName !== undefined) {
    return byName;
  }
  if (!(material instanceof ModelGlassMaterial)) {
    return undefined;
  }
  return FLUID_MEDIA.find(
    (fluid) =>
      Math.abs(material.nd - fluid.nd) <= FLUID_TOLERANCE.nd &&
      Math.abs(material.abbeNumber - fluid.abbeNumber) <= FLUID_TOLERANCE.abbeNumber,
  );
}

/** True for a medium nothing can be made of: air, vacuum, water, oil. */
export function isFluid(material: Material): boolean {
  return material.name === AIR.name || fluidMedium(material) !== undefined;
}

/**
 * True when this medium is something an element could be made of — the test for
 * whether a surface is the *face* of a piece of glass rather than a plane in a
 * fluid.
 *
 * The fluid check runs first, and not only for speed: a catalog fluid carries a
 * narrow published fit range (water's is 400–700 nm) and `indexAt` refuses to
 * extrapolate, so asking a tank of water for its index at 1064 nm throws. It is
 * not a question worth asking about a medium that cannot be an element anyway.
 */
export function isSolid(material: Material, wavelengthNm: number): boolean {
  if (isFluid(material)) {
    return false;
  }
  return Math.abs(material.indexAt(wavelengthNm) - 1) >= 1e-9;
}
