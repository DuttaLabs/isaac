import type { Material } from '@isaac/optical-core';
import { GlassMaterial, type GlassMaterialOptions } from './glass.ts';
import type { GlassRecord } from './types.ts';

export interface GlassLookup {
  glass: GlassMaterial;
  /**
   * Set when the requested name was not in the catalog and a modern
   * equivalent was substituted (see {@link GlassCatalogOptions.allowLegacyNames}).
   */
  substitutedFor?: string;
  /**
   * Set when the requested name is one SCHOTT has retired in favour of another
   * name for the same glass — `BAFN10` for `N-BAF10`. Unlike
   * {@link substitutedFor} this is not a guess from the spelling: the pairing
   * was verified against SCHOTT's own published fit for the retired name, and
   * across the visible the two agree to better than 5e-5. About half the pairs
   * are bit-identical fits; for the others SCHOTT publishes two fits that agree
   * in the visible and drift by up to 4e-3 at the far ends of the published
   * range, so treat this as exact where Isaac's wavelengths lie and approximate
   * in the UV and near IR.
   */
  renamedFrom?: string;
}

export interface GlassCatalogOptions extends GlassMaterialOptions {
  /**
   * Accept an obsolete name by falling back to the glass SCHOTT names by
   * prefixing `N-`, *without* checking that the two are the same glass. This
   * is a guess from the spelling, and it is often wrong: `SF18` and `N-SF19`
   * differ by 0.055 in index, and `PK2` and `N-PK52A` by 16.6 in Abbe number.
   * Renames that were verified as the same glass do not need this option — see
   * {@link SCHOTT_RENAMES} — so what is left here really is a different glass.
   * Off by default; lookups report the substitution in
   * {@link GlassLookup.substitutedFor} when it happens.
   */
  allowLegacyNames?: boolean;
}

/**
 * A searchable set of glasses. Lookup is insensitive to case and to the
 * separators that lens files vary on, so `N-BK7`, `n bk7`, and `NBK7` all find
 * the same glass.
 */
export class GlassCatalog {
  private readonly byNormalizedName: ReadonlyMap<string, GlassRecord>;
  private readonly options: GlassCatalogOptions;
  /** Normalized retired name → normalized current name. */
  private readonly renames: ReadonlyMap<string, string>;

  public constructor(
    records: readonly GlassRecord[],
    options: GlassCatalogOptions = {},
    renames: ReadonlyArray<readonly [legacy: string, current: string]> = [],
  ) {
    const byNormalizedName = new Map<string, GlassRecord>();
    for (const record of records) {
      const key = normalizeGlassName(record.name);
      const clash = byNormalizedName.get(key);
      if (clash) {
        throw new RangeError(
          `Glass names "${clash.name}" and "${record.name}" are indistinguishable after normalization.`,
        );
      }
      byNormalizedName.set(key, record);
    }

    const renameMap = new Map<string, string>();
    for (const [legacy, current] of renames) {
      const key = normalizeGlassName(legacy);
      // A retired name that is also a live glass is a contradiction in the
      // data, and the rename would be unreachable behind the direct hit.
      const shadowed = byNormalizedName.get(key);
      if (shadowed) {
        throw new RangeError(
          `"${legacy}" is listed as a retired name for "${current}" but is itself in the catalog as "${shadowed.name}".`,
        );
      }
      renameMap.set(key, normalizeGlassName(current));
    }

    this.byNormalizedName = byNormalizedName;
    this.options = options;
    this.renames = renameMap;
  }

  public get size(): number {
    return this.byNormalizedName.size;
  }

  /** Every glass name, in catalog spelling, sorted. */
  public names(): string[] {
    return [...this.byNormalizedName.values()].map((record) => record.name).sort();
  }

  public records(): GlassRecord[] {
    return [...this.byNormalizedName.values()];
  }

  public has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  /** Finds a glass by name, or returns `undefined`. */
  public get(name: string): GlassMaterial | undefined {
    return this.lookup(name)?.glass;
  }

  /** Like {@link get}, but also reports whether a rename or substitution was made. */
  public lookup(name: string): GlassLookup | undefined {
    const direct = this.byNormalizedName.get(normalizeGlassName(name));
    if (direct) {
      return { glass: new GlassMaterial(direct, this.options) };
    }

    // A retired name for a glass that is still in the catalog under a current
    // name. Needs no opt-in: the dispersion was checked against SCHOTT's own fit
    // for the retired name, so this resolves the glass the name meant rather
    // than guessing at one from the spelling.
    const current = this.renames.get(normalizeGlassName(name));
    const renamed = current === undefined ? undefined : this.byNormalizedName.get(current);
    if (renamed) {
      return { glass: new GlassMaterial(renamed, this.options), renamedFrom: name.trim() };
    }

    if (this.options.allowLegacyNames) {
      const replacement = this.byNormalizedName.get(normalizeGlassName(`N-${name}`));
      if (replacement) {
        return { glass: new GlassMaterial(replacement, this.options), substitutedFor: name.trim() };
      }
    }
    return undefined;
  }

  /** Returns a catalog with different lookup options. */
  public with(options: GlassCatalogOptions): GlassCatalog {
    return new GlassCatalog(this.records(), { ...this.options, ...options }, [...this.renames]);
  }

  /** A resolver function shaped for `zemax-io`'s `resolveMaterial` option. */
  public resolver(): (glassName: string) => Material | undefined {
    return (glassName: string) => this.get(glassName);
  }
}

/**
 * Lens files spell glass names inconsistently — `N-BK7`, `N BK7`, `nbk7`.
 * Normalizing away case and separators makes lookup forgiving without needing
 * an alias table.
 */
export function normalizeGlassName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '');
}
