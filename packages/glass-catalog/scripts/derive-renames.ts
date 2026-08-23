/**
 * Regenerates `src/renames.ts` from SCHOTT's own Zemax-format catalog.
 *
 *   npm run regenerate-renames --workspace @isaac/glass-catalog -- <path to .AGF>
 *
 * SCHOTT's catalog still lists the names it has retired, and gives each one a
 * dispersion fit. Where that fit is identical to a glass already in
 * `src/schott.ts`, the two names are the same glass and the old one is an alias
 * — which is what this script extracts. **Only the name pairs are emitted**; no
 * coefficients are copied out of the AGF, so the generated file carries no
 * manufacturer data, just the mapping between two spellings of one glass.
 *
 * A name is only emitted when two independent signals agree, because the
 * catalog holds genuine near-duplicates — `N-BK7` and `N-BK7HT` have the same
 * dispersion and are different products, so "closest fit" alone picks between
 * them by accident:
 *
 *   1. the dispersion agrees to better than `TOLERANCE` across the visible, and
 *   2. either SCHOTT's own renaming rule predicts the modern name, or exactly
 *      one catalog glass is that close.
 *
 * Anything ambiguous is listed on stderr and left out rather than guessed at.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SellmeierMaterial } from '@isaac/optical-core';
import { GlassCatalog } from '../src/catalog.ts';
import { SCHOTT_GLASSES } from '../src/schott.ts';

/**
 * Built from the records alone, *not* the ready-made `SCHOTT`. That one already
 * carries the table this script writes, so asking it what it can resolve would
 * hide every name already listed and regenerate an empty file.
 */
const GLASSES = new GlassCatalog(SCHOTT_GLASSES);

/** SCHOTT's Zemax catalog writes the three-term Sellmeier as formula 2. */
const SELLMEIER_FORMULA = 2;

/** Max |Δn| across the visible for two names to be one glass. */
const TOLERANCE = 5e-5;
const SAMPLE_NM = { from: 450, to: 650, step: 10 };

const DEFAULT_AGF = fileURLToPath(
  new URL(
    '../../../SupportingMaterial/schott glasses preferred and special June-2025-B.AGF',
    import.meta.url,
  ),
);
const OUTPUT = fileURLToPath(new URL('../src/renames.ts', import.meta.url));

const agfPath = process.argv[2] ?? DEFAULT_AGF;
const source = await readAgf(agfPath);
console.log(`Read ${source.glasses.length} glasses from ${source.title}`);

const catalog = GLASSES.records().map((record) => ({
  name: record.name,
  material: GLASSES.get(record.name)!,
}));

const renames: Array<{ from: string; to: string; error: number }> = [];
const ambiguous: string[] = [];

for (const glass of source.glasses) {
  // Only names our catalog cannot already reach, and only fits the core models.
  if (glass.formula !== SELLMEIER_FORMULA || !glass.coefficients || GLASSES.has(glass.name)) {
    continue;
  }

  const legacy = new SellmeierMaterial(glass.name, glass.coefficients);
  const close = catalog
    .map(({ name, material }) => ({ name, error: maxIndexDifference(legacy, material) }))
    .filter((candidate) => candidate.error < TOLERANCE)
    .sort((a, b) => a.error - b.error);

  if (close.length === 0) {
    continue;
  }

  // Signal two: SCHOTT renamed lead-free replacements by moving the `N` onto
  // the front, so `BAFN10` became `N-BAF10` and `SSKN5` became `N-SSK5`.
  const predicted = close.find((candidate) => renamingRulePredicts(glass.name, candidate.name));
  const chosen = predicted ?? (close.length === 1 ? close[0] : undefined);

  if (!chosen) {
    ambiguous.push(`${glass.name} → ${close.map((c) => c.name).join(' / ')}`);
    continue;
  }
  renames.push({ from: glass.name, to: chosen.name, error: chosen.error });
}

renames.sort((a, b) => a.from.localeCompare(b.from));
console.log(`Verified renames: ${renames.length}. Ambiguous, left out: ${ambiguous.length}.`);
for (const entry of ambiguous) {
  console.error(`  ambiguous: ${entry}`);
}

await writeFile(OUTPUT, renderModule(renames, source.title), 'utf8');
console.log(`Wrote ${OUTPUT}`);

interface AgfGlass {
  name: string;
  formula: number;
  coefficients?: {
    b1: number;
    c1: number;
    b2: number;
    c2: number;
    b3: number;
    c3: number;
  };
}

/**
 * Pulls names and dispersion fits out of a Zemax `.AGF` catalog. `NM` opens a
 * glass (name, then the dispersion formula number), and `CD` carries the
 * coefficients, interleaved as `B₁ C₁ B₂ C₂ B₃ C₃`.
 */
async function readAgf(path: string): Promise<{ title: string; glasses: AgfGlass[] }> {
  // AGF files are Latin-1; a stray degree sign in a comment must not derail the
  // parse, and no name or number is outside ASCII.
  const text = (await readFile(path, 'latin1')).replace(/\r/g, '');
  const glasses: AgfGlass[] = [];
  let title = path;
  let current: AgfGlass | undefined;

  for (const line of text.split('\n')) {
    const comment = /^CC\s+(.+)$/.exec(line);
    if (comment && glasses.length === 0) {
      title = comment[1]!.trim();
      continue;
    }
    const name = /^NM\s+(.+)$/.exec(line);
    if (name) {
      const fields = name[1]!.trim().split(/\s+/);
      current = { name: fields[0]!, formula: Number(fields[1]) };
      glasses.push(current);
      continue;
    }
    const coefficients = /^CD\s+(.+)$/.exec(line);
    if (coefficients && current) {
      const values = coefficients[1]!.trim().split(/\s+/).map(Number);
      if (values.length >= 6 && !values.slice(0, 6).some(Number.isNaN)) {
        current.coefficients = {
          b1: values[0]!,
          c1: values[1]!,
          b2: values[2]!,
          c2: values[3]!,
          b3: values[4]!,
          c3: values[5]!,
        };
      }
    }
  }
  if (glasses.length === 0) {
    throw new Error(`No glasses found in ${path}; is it a Zemax .AGF catalog?`);
  }
  return { title, glasses };
}

function maxIndexDifference(a: SellmeierMaterial, b: { indexAt(nm: number): number }): number {
  let worst = 0;
  for (let nm = SAMPLE_NM.from; nm <= SAMPLE_NM.to; nm += SAMPLE_NM.step) {
    try {
      worst = Math.max(worst, Math.abs(a.indexAt(nm) - b.indexAt(nm)));
    } catch {
      // Outside the modern glass's published range; it cannot be the match.
      return Infinity;
    }
  }
  return worst;
}

/**
 * True when SCHOTT's renaming rule turns `legacy` into `modern`: the lead-free
 * replacements took an `N-` prefix, and where the old name already carried an
 * `N` before its number that `N` moved to the front rather than doubling up.
 */
function renamingRulePredicts(legacy: string, modern: string): boolean {
  const target = key(modern);
  return key(`N-${legacy}`) === target || key(`N-${legacy.replace(/N(?=\d)/, '')}`) === target;
}

function key(name: string): string {
  return name.toUpperCase().replace(/[\s_-]+/g, '');
}

function renderModule(
  renames: ReadonlyArray<{ from: string; to: string; error: number }>,
  title: string,
): string {
  // Unpadded: Prettier formats this file like any other and would strip
  // alignment back out, leaving every regeneration with a spurious diff.
  const rows = renames.map((rename) => `  ['${rename.from}', '${rename.to}'],`);

  return `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run regenerate-renames --workspace @isaac/glass-catalog -- <path to .AGF>
//
// Source: ${title}
//
// Names SCHOTT has retired, each paired with the glass in \`schott.ts\` that
// carries the same dispersion. The pairing is not a guess from the spelling: it
// was verified by comparing SCHOTT's published fit for the old name against the
// modern glass, and only pairs agreeing to better than ${TOLERANCE.toExponential(0)} across
// 450–650 nm are here. Where more than one modern glass is that close — the
// catalog has real near-duplicates, such as N-BK7 and N-BK7HT — the pair is
// only kept when SCHOTT's own renaming rule picks the same one.
//
// These are therefore *aliases*, not substitutions: the same glass under two
// names, traced identically. A genuinely different replacement glass does not
// belong here — see GlassCatalogOptions.allowLegacyNames for those.

/** ${renames.length} retired SCHOTT names, each with the current name for the same glass. */
export const SCHOTT_RENAMES: ReadonlyArray<readonly [legacy: string, current: string]> = [
${rows.join('\n')}
];
`;
}
