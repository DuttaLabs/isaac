import type { Material } from '@isaac/optical-core';
import { GlassMaterial, type GlassMaterialOptions } from './glass.ts';
import type { GlassRecord } from './types.ts';

/**
 * Options for a catalog. There is deliberately nothing here about resolving a
 * name the catalog does not hold: it used to be able to guess, reaching `N-<x>`
 * from `<x>`, and that guess bought nothing once SCHOTT's retired names became
 * entries of their own — measured over the 471 OpticStudio samples it unlocked
 * exactly zero further files — while being wrong often enough to matter
 * (`SF18` and `N-SF19` differ by 0.055 in index, `PK2` and `N-PK52A` by 16.6 in
 * Abbe number). A name is now either in the manufacturer's catalog or it is
 * not, and an unknown one is reported rather than approximated.
 */
export type GlassCatalogOptions = GlassMaterialOptions;

/**
 * A searchable set of glasses. Lookup is insensitive to case and to the
 * separators that lens files vary on, so `N-BK7`, `n bk7`, and `NBK7` all find
 * the same glass.
 */
export class GlassCatalog {
  private readonly byNormalizedName: ReadonlyMap<string, GlassRecord>;
  private readonly options: GlassCatalogOptions;

  public constructor(records: readonly GlassRecord[], options: GlassCatalogOptions = {}) {
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

    this.byNormalizedName = byNormalizedName;
    this.options = options;
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
    return this.byNormalizedName.has(normalizeGlassName(name));
  }

  /** Finds a glass by name, or returns `undefined`. */
  public get(name: string): GlassMaterial | undefined {
    const record = this.byNormalizedName.get(normalizeGlassName(name));
    return record && new GlassMaterial(record, this.options);
  }

  /** Returns a catalog with different lookup options. */
  public with(options: GlassCatalogOptions): GlassCatalog {
    return new GlassCatalog(this.records(), { ...this.options, ...options });
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
