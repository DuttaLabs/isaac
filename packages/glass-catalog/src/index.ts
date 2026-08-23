export type { GlassRecord } from './types.ts';
export { GlassMaterial, D_LINE_NM, F_LINE_NM, C_LINE_NM } from './glass.ts';
export type { GlassMaterialOptions } from './glass.ts';
export { GlassCatalog, normalizeGlassName } from './catalog.ts';
export type { GlassCatalogOptions, GlassLookup } from './catalog.ts';
export { SCHOTT_GLASSES } from './schott.ts';
export { SCHOTT_RENAMES } from './renames.ts';

import { GlassCatalog } from './catalog.ts';
import { SCHOTT_GLASSES } from './schott.ts';
import { SCHOTT_RENAMES } from './renames.ts';

/** The SCHOTT catalog, ready to query, including the names SCHOTT has retired. */
export const SCHOTT = new GlassCatalog(SCHOTT_GLASSES, {}, SCHOTT_RENAMES);
