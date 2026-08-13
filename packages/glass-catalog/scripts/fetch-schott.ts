/**
 * Regenerates `src/schott.ts` from the refractiveindex.info database.
 *
 *   npm run regenerate --workspace @isaac/glass-catalog
 *
 * That database is public domain (CC0 1.0) and its SCHOTT pages are generated
 * from SCHOTT's own Zemax catalogue, so the coefficients are the manufacturer's
 * published values rather than a third-party refit.
 *
 * Only entries published as "formula 2" — the three-term Sellmeier form
 * `n² − 1 = Σ Bᵢλ²/(λ² − Cᵢ)` that `optical-core` implements — are emitted.
 * Anything else (tabulated data, or a fit carrying a constant term) is listed as
 * skipped rather than approximated.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const RAW_BASE =
  'https://raw.githubusercontent.com/polyanskiy/refractiveindex.info-database/master/database';
const CATALOG_URL = `${RAW_BASE}/catalog-nk.yml`;
const OUTPUT = fileURLToPath(new URL('../src/schott.ts', import.meta.url));

interface Extracted {
  name: string;
  catalog: string;
  rangeUm: [number, number];
  coefficients: number[];
}

const catalogText = await fetchText(CATALOG_URL);
const paths = [...new Set(catalogText.match(/specs\/schott\/[a-z]+\/[^\s]+\.yml/g) ?? [])].sort();
if (paths.length === 0) {
  throw new Error('No SCHOTT spec paths found; the database layout may have changed.');
}
console.log(`Found ${paths.length} SCHOTT entries.`);

const glasses: Extracted[] = [];
const skipped: string[] = [];

for (const path of paths) {
  const [, , catalog, file] = path.split('/');
  const name = file!.replace(/\.yml$/, '');
  const spec = await fetchText(`${RAW_BASE}/data/${path}`);
  const extracted = extractSellmeier(spec);
  if (!extracted) {
    skipped.push(`${name} (${catalog})`);
    continue;
  }
  glasses.push({ name, catalog: catalog!, ...extracted });
}

glasses.sort((a, b) => a.name.localeCompare(b.name));
console.log(`Usable three-term Sellmeier fits: ${glasses.length}. Skipped: ${skipped.length}.`);
await writeFile(OUTPUT, renderModule(glasses, skipped), 'utf8');
console.log(`Wrote ${OUTPUT}`);

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return response.text();
}

/** Pulls the `formula 2` block out of a spec file, if it has one. */
function extractSellmeier(
  spec: string,
): { rangeUm: [number, number]; coefficients: number[] } | undefined {
  const match = spec.match(
    /type:\s*formula 2\s*\n\s*wavelength_range:\s*(\S+)\s+(\S+)\s*\n\s*coefficients:\s*([^\n]+)/,
  );
  if (!match) {
    return undefined;
  }
  const coefficients = match[3]!.trim().split(/\s+/).map(Number);
  // "formula 2" is [constant, B1, C1, B2, C2, B3, C3]; the core's material has
  // no constant term, so only a leading zero is representable.
  if (coefficients.length !== 7 || coefficients[0] !== 0 || coefficients.some(Number.isNaN)) {
    return undefined;
  }
  return { rangeUm: [Number(match[1]), Number(match[2])], coefficients };
}

function renderModule(glasses: Extracted[], skipped: string[]): string {
  const rows = glasses.map((glass) => {
    const [, b1, c1, b2, c2, b3, c3] = glass.coefficients;
    const [min, max] = glass.rangeUm;
    return (
      `  g('${glass.name}', '${glass.catalog}', ` +
      `${b1}, ${c1}, ${b2}, ${c2}, ${b3}, ${c3}, ${min * 1000}, ${max * 1000}),`
    );
  });

  return `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run regenerate --workspace @isaac/glass-catalog
//
// Source: refractiveindex.info database (public domain, CC0 1.0), whose SCHOTT
// pages are generated from SCHOTT's own Zemax catalogue (schott_2017-01-20b.agf).
// Coefficients are the manufacturer's published three-term Sellmeier fits:
//   n² − 1 = B₁λ²/(λ² − C₁) + B₂λ²/(λ² − C₂) + B₃λ²/(λ² − C₃),  λ in µm.
//
// Skipped (not representable as a three-term Sellmeier): ${skipped.join(', ') || 'none'}.

import type { GlassRecord } from './types.ts';

function g(
  name: string,
  catalog: string,
  b1: number,
  c1: number,
  b2: number,
  c2: number,
  b3: number,
  c3: number,
  minNm: number,
  maxNm: number,
): GlassRecord {
  return {
    name,
    manufacturer: 'SCHOTT',
    catalog,
    coefficients: { b1, b2, b3, c1, c2, c3 },
    rangeNm: [minNm, maxNm],
  };
}

/** ${glasses.length} SCHOTT glasses with a published three-term Sellmeier fit. */
export const SCHOTT_GLASSES: readonly GlassRecord[] = [
${rows.join('\n')}
];
`;
}
