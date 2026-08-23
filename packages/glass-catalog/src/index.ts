export type { GlassRecord, GlassStatus } from './types.ts';
export { GLASS_STATUS } from './types.ts';
export { GlassMaterial, D_LINE_NM, F_LINE_NM, C_LINE_NM } from './glass.ts';
export type { GlassMaterialOptions } from './glass.ts';
export { GlassCatalog, normalizeGlassName } from './catalog.ts';
export type { GlassCatalogOptions } from './catalog.ts';
export { SCHOTT_GLASSES } from './schott.ts';
export { OHARA_GLASSES } from './ohara.ts';

import { GlassCatalog } from './catalog.ts';
import { SCHOTT_GLASSES } from './schott.ts';
import { OHARA_GLASSES } from './ohara.ts';

/** SCHOTT's catalog, ready to query — every entry the manufacturer publishes. */
export const SCHOTT = new GlassCatalog(SCHOTT_GLASSES);

/** Ohara's catalog, ready to query — every entry the manufacturer publishes. */
export const OHARA = new GlassCatalog(OHARA_GLASSES);

/**
 * Every glass from every manufacturer in one catalog — what a lens file wants,
 * since a `.zmx` names a glass and not the catalog it came from.
 *
 * Construction throws if two makers use one name once normalized. That is the
 * right failure: the file would be ambiguous, and picking a winner silently
 * would trace someone else's glass. No name is shared between SCHOTT's 366 and
 * Ohara's 433 today, so the check costs nothing until it matters.
 */
export const ALL_GLASSES = new GlassCatalog([...SCHOTT_GLASSES, ...OHARA_GLASSES]);
