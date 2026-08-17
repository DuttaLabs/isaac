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
}

export interface GlassCatalogOptions extends GlassMaterialOptions {
  /**
   * Accept obsolete lead-containing names by falling back to SCHOTT's
   * lead-free replacement, which the manufacturer names by prefixing `N-`
   * (BK7 → N-BK7, SK16 → N-SK16). The replacements are designed to the same
   * nd/vd, but they are *not* the same glass: indices differ in the fourth
   * decimal. Off by default; lookups report the substitution when it happens.
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
    return this.lookup(name) !== undefined;
  }

  /** Finds a glass by name, or returns `undefined`. */
  public get(name: string): GlassMaterial | undefined {
    return this.lookup(name)?.glass;
  }

  /** Like {@link get}, but also reports whether a legacy substitution was made. */
  public lookup(name: string): GlassLookup | undefined {
    const direct = this.byNormalizedName.get(normalizeGlassName(name));
    if (direct) {
      return { glass: new GlassMaterial(direct, this.options) };
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
