export type { GlassRecord, GlassStatus } from './types.ts';
export { GLASS_STATUS } from './types.ts';
export { GlassMaterial, D_LINE_NM, F_LINE_NM, C_LINE_NM } from './glass.ts';
export type { GlassMaterialOptions } from './glass.ts';
export { GlassCatalog, normalizeGlassName } from './catalog.ts';
export type { GlassCatalogOptions } from './catalog.ts';
export { SCHOTT_GLASSES } from './schott.ts';
export { OHARA_GLASSES } from './ohara.ts';
export { MISC_GLASSES } from './misc.ts';

import { GlassCatalog, normalizeGlassName } from './catalog.ts';
import { SCHOTT_GLASSES } from './schott.ts';
import { OHARA_GLASSES } from './ohara.ts';
import { MISC_GLASSES } from './misc.ts';

/** SCHOTT's catalog, ready to query — every entry the manufacturer publishes. */
export const SCHOTT = new GlassCatalog(SCHOTT_GLASSES);

/** Ohara's catalog, ready to query — every entry the manufacturer publishes. */
export const OHARA = new GlassCatalog(OHARA_GLASSES);

/**
 * Materials rather than products, 23 of them: fused silica and quartz, calcium
 * fluoride, Pyrex, water and seawater, the common plastics (PMMA, polycarbonate,
 * polystyrene, CR-39, acrylic), a few crystals (CdS, KDP, TeO₂), and `VACUUM`.
 * Things a lens is made of, or sits in, that no maker sells under a catalog
 * name — so each entry cites its own literature source (mostly the Handbook of
 * Optics) rather than a manufacturer's datasheet.
 */
export const MISC = new GlassCatalog(MISC_GLASSES);

/**
 * Names claimed by more than one catalog, resolved to the earlier one.
 *
 * There is exactly one, and it is a real ambiguity rather than a duplicate:
 * **`LAF3`** is an obsolete SCHOTT lanthanum flint (nd 1.717, Vd 48.0) and, in
 * MISC, the crystal lanthanum fluoride (nd 1.604, Vd 80.8). Two materials, one
 * name, and no way to tell from a `.zmx` which was meant — a file says `GCAT`
 * to name the libraries to search, and this reader does not yet use it.
 *
 * So a manufacturer's catalog wins, on the grounds that a lens prescription
 * naming `LAF3` is far likelier to mean the glass someone melted than the
 * crystal. **The shadowed entry is not lost** — `MISC.get('LAF3')` still returns
 * it — and it is named here rather than quietly dropped, with a test asserting
 * this list is exactly what it says. A second collision arriving should stop
 * somebody and make them look, which is what the constructor's own throw does
 * for two catalogs and what that test does for three.
 */
export const SHADOWED_GLASS_NAMES: readonly string[] = ['LAF3'];

/**
 * Every glass from every catalog in one, ordered — what a lens file wants, since
 * a `.zmx` names a glass and not the library it came from.
 *
 * The order is the precedence: the makers' own catalogs, then the materials.
 * `GlassCatalog` throws on a name it cannot tell apart, so the duplicates are
 * removed here deliberately and listed above rather than being left to collide.
 */
const ordered = [...SCHOTT_GLASSES, ...OHARA_GLASSES, ...MISC_GLASSES];
const claimed = new Set<string>();
export const ALL_GLASSES = new GlassCatalog(
  ordered.filter((record) => {
    const key = normalizeGlassName(record.name);
    if (claimed.has(key)) {
      return false;
    }
    claimed.add(key);
    return true;
  }),
);
