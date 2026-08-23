export type { GlassRecord, GlassStatus } from './types.ts';
export { GLASS_STATUS } from './types.ts';
export { GlassMaterial, D_LINE_NM, F_LINE_NM, C_LINE_NM } from './glass.ts';
export type { GlassMaterialOptions } from './glass.ts';
export { GlassCatalog, normalizeGlassName } from './catalog.ts';
export type { GlassCatalogOptions } from './catalog.ts';
export { SCHOTT_GLASSES } from './schott.ts';

import { GlassCatalog } from './catalog.ts';
import { SCHOTT_GLASSES } from './schott.ts';

/** SCHOTT's catalog, ready to query — every entry the manufacturer publishes. */
export const SCHOTT = new GlassCatalog(SCHOTT_GLASSES);
