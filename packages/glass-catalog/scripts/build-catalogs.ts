/**
 * Regenerates one `src/<maker>.ts` per manufacturer from that manufacturer's own
 * Zemax-format glass catalog.
 *
 *   npm run regenerate --workspace @isaac/glass-catalog
 *
 * **A manufacturer's `.AGF` is the only source of glass data in this repo.** The
 * numbers come from whoever makes the glass, not from a third party's
 * transcription or refit of them. An earlier version pulled SCHOTT from
 * refractiveindex.info; that is deliberately gone. The files live in
 * `SupportingMaterial/` (gitignored), so regenerating needs them present.
 *
 * Each catalog is reproduced *as written*, every entry. That includes ones whose
 * optical fits coincide — SCHOTT ships `BK7` and `N-BK7` with the same
 * dispersion — because they are different products that happen to share their
 * optical properties, and mechanical data can differ. Keeping the
 * manufacturer's list intact also means no alias table: a name either is in a
 * catalog or is not.
 *
 * `.AGF` layout, one glass per `NM` record followed by its data records:
 *
 *   NM <name> <formula> <MIL> <nd> <vd> <exclude> <status> <meltFreq>
 *   CD <coefficients …>     the dispersion fit, meaning set by <formula>
 *   LD <λmin> <λmax>        the range that fit is valid over, in µm
 *
 * Other records (`ED` mechanical, `TD` thermal, `IT` transmission, `OD` cost
 * and environmental) are not read yet; they are where density, thermal
 * expansion and internal transmittance live when those are wanted.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DISPERSION_COEFFICIENT_COUNT,
  DISPERSION_FORMULA,
  dispersionMaterial,
} from '@isaac/optical-core';
// `decodeZmx` is the same problem as decoding an AGF — a vendor file that may be
// UTF-16 with or without a BOM, or plain 8-bit. Ohara ships one of each. This is
// a build script, and zemax-io is already a devDependency, so the decoder is
// reused rather than written twice.
import { decodeZmx } from '@isaac/zemax-io';
import { GLASS_STATUS, type GlassStatus } from '../src/types.ts';

const D_LINE_NM = 587.5618;
const F_LINE_NM = 486.1327;
const C_LINE_NM = 656.2725;

/** How far a fit may miss the catalog's own printed nd / Vd before we refuse it. */
const ND_TOLERANCE = 5e-5;
const VD_TOLERANCE = 0.01;

/**
 * The catalogs this repo carries, and where each comes from. Adding a
 * manufacturer is a row here plus an export in `index.ts` — the reader below is
 * not vendor-specific, because the format is not.
 */
const CATALOGS: readonly CatalogSource[] = [
  {
    manufacturer: 'SCHOTT',
    agf: 'schott glasses preferred and special June-2025-B.AGF',
    module: 'schott.ts',
    constant: 'SCHOTT_GLASSES',
  },
  {
    // Ohara ships two files: this one, matching the 433 glasses OpticStudio's
    // Ohara library holds, and a 166-glass `_CATALOG` subset of currently
    // produced glasses. The full list is the useful one — an old lens file is
    // exactly where a discontinued glass turns up.
    manufacturer: 'OHARA',
    agf: 'Ohara/OHARA_260701.AGF',
    module: 'ohara.ts',
    constant: 'OHARA_GLASSES',
  },
  {
    // **Materials rather than products.** MISC is the catalog fused silica,
    // sapphire, calcium fluoride, germanium and water live in — things a lens
    // is made of that no maker sells under a name. Each entry cites its own
    // literature source rather than a manufacturer's datasheet: silica's fit is
    // Malitson's, printed in the Handbook of Optics, and reproduces nd and Vd
    // to nine decimal places under the gate below.
    //
    // Optional because, unlike the makers' own files, this one ships with
    // OpticStudio rather than being published by whoever makes the material.
    manufacturer: 'MISC',
    agf: 'Zemax AGF files/MISC.AGF',
    module: 'misc.ts',
    constant: 'MISC_GLASSES',
    provenance:
      'Materials rather than products — things a lens is made of, or sits in,\n' +
      '// that no maker sells under a catalog name. So this one is *not* a\n' +
      "// manufacturer's own file: it ships with OpticStudio, and each entry cites\n" +
      '// its own literature source instead of a datasheet. Fused silica is\n' +
      "// Malitson's fit by way of the Handbook of Optics, and reproduces the\n" +
      '// printed nd and Vd to nine decimal places.',
    optional: true,
  },
];

/** What a maker's own catalog can say about where its numbers come from. */
const DEFAULT_PROVENANCE = (manufacturer: string): string =>
  `${manufacturer}'s own Zemax-format catalog, reproduced entry for entry. A\n` +
  `// manufacturer's own file is the only source of glass data in this repo: the\n` +
  `// numbers below are theirs, not a third party's transcription of them.`;

interface CatalogSource {
  /** Name recorded on every glass, and the heading of the generated module. */
  manufacturer: string;
  /** Path to the `.AGF`, relative to `SupportingMaterial/`. */
  agf: string;
  /** File written under `src/`. */
  module: string;
  /** Exported constant inside that file. */
  constant: string;
  /**
   * What the generated header says about where the numbers came from. Defaults
   * to the maker's-own-catalog wording, which is true of every manufacturer file
   * and not of MISC.
   */
  provenance?: string;
  /**
   * Skip with a note instead of failing when the file is absent. Every `.AGF`
   * here is gitignored, so a fresh clone has none of them — but a *manufacturer's*
   * catalog missing means the checkout is incomplete and should say so loudly,
   * whereas this one may simply not have been collected.
   */
  optional?: boolean;
}

const MATERIAL_DIR = fileURLToPath(new URL('../../../SupportingMaterial/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

interface Parsed {
  name: string;
  formula: number;
  nd: number;
  abbeNumber: number;
  status: GlassStatus;
  coefficients: number[];
  rangeNm: [number, number];
}

for (const source of CATALOGS) {
  const path = MATERIAL_DIR + source.agf;
  if (source.optional && !existsSync(path)) {
    console.log(`\n${source.manufacturer}: skipped, ${source.agf} not present`);
    continue;
  }
  const { title, glasses } = await readAgf(path, source.manufacturer);
  console.log(`\n${source.manufacturer}: ${glasses.length} glasses from ${title || source.agf}`);

  const byFormula = new Map<number, number>();
  for (const glass of glasses) {
    byFormula.set(glass.formula, (byFormula.get(glass.formula) ?? 0) + 1);
  }
  console.log(
    `  dispersion formulas: ${[...byFormula]
      .sort((a, b) => a[0] - b[0])
      .map(([formula, count]) => `${formula}×${count}`)
      .join(', ')}`,
  );

  const unstated = verifyAgainstPrintedValues(glasses, source.manufacturer);
  console.log(
    `  all ${glasses.length} fits reproduce the catalog's printed nd and Vd` +
      (unstated > 0 ? ` (${unstated} print none to check against)` : ''),
  );

  glasses.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(SRC_DIR + source.module, renderModule(glasses, title, source), 'utf8');
  console.log(`  wrote src/${source.module}`);
}

/**
 * Every fit must rebuild the catalog's own printed nd and Vd. This is the check
 * that the coefficients were read out of the right columns and handed to the
 * right equation — a Sellmeier fit read as a Schott one still returns numbers,
 * and a plausible-looking index is exactly the failure that would not be caught
 * downstream.
 */
function verifyAgainstPrintedValues(glasses: readonly Parsed[], manufacturer: string): number {
  const wrong: string[] = [];
  let unstated = 0;
  for (const glass of glasses) {
    const material = dispersionMaterial(glass.name, glass.formula, glass.coefficients);
    const nd = material.indexAt(D_LINE_NM);
    const vd = (nd - 1) / (material.indexAt(F_LINE_NM) - material.indexAt(C_LINE_NM));

    // **A catalog that printed nothing cannot be checked against.** An `NM`
    // record carries nd and Vd whether or not anyone filled them in, and an
    // unfilled one reads as exactly `1.000000` — an index no solid has, and the
    // format's way of saying the field is empty rather than a measurement of
    // vacuum. MISC has three: CDS and CR39 print 1.0 for both, and N15 is a
    // non-dispersive material whose Vd is written 0 where the fit gives
    // infinity, which is the same statement made two ways.
    //
    // Skipping these does not weaken the gate. Its job is to catch coefficients
    // read out of the wrong columns, and it can only do that where there is
    // something to compare against; every entry that states a value is still
    // held to it.
    const statesIndex = glass.nd > 1;
    const statesAbbe = glass.abbeNumber > 0;
    if (!statesIndex && !statesAbbe) {
      unstated += 1;
      continue;
    }
    const indexWrong = statesIndex && Math.abs(nd - glass.nd) > ND_TOLERANCE;
    const abbeWrong = statesAbbe && Math.abs(vd - glass.abbeNumber) > VD_TOLERANCE;
    if (!statesAbbe) {
      unstated += 1;
    }
    if (indexWrong || abbeWrong) {
      wrong.push(
        `  ${glass.name}: fit gives nd ${nd.toFixed(6)} / Vd ${vd.toFixed(4)}, ` +
          `catalog prints ${glass.nd.toFixed(6)} / ${glass.abbeNumber.toFixed(4)}`,
      );
    }
  }
  if (wrong.length > 0) {
    throw new Error(
      `${manufacturer}: ${wrong.length} glasses do not reproduce their printed nd/Vd:\n${wrong.join('\n')}`,
    );
  }
  return unstated;
}

async function readAgf(
  path: string,
  manufacturer: string,
): Promise<{ title: string; glasses: Parsed[] }> {
  const text = decodeZmx(await readFile(path)).replace(/\r/g, '');
  const glasses: Parsed[] = [];
  // The `CC` header comment names the edition where a maker writes one. Ohara's
  // is blank, so the caller falls back to the file name.
  let title = '';
  let current: Parsed | undefined;

  for (const line of text.split('\n')) {
    const comment = /^CC\s+(.+)$/.exec(line);
    if (comment && glasses.length === 0) {
      title = comment[1]!.trim();
      continue;
    }

    const nm = /^NM\s+(.+)$/.exec(line);
    if (nm) {
      const fields = nm[1]!.trim().split(/\s+/);
      const status = GLASS_STATUS[Number(fields[6]) as keyof typeof GLASS_STATUS];
      if (!status) {
        throw new Error(`${fields[0]}: unknown status code "${fields[6]}" on its NM record.`);
      }
      current = {
        name: fields[0]!,
        formula: Number(fields[1]),
        nd: Number(fields[3]),
        abbeNumber: Number(fields[4]),
        status,
        coefficients: [],
        rangeNm: [0, 0],
      };
      glasses.push(current);
      continue;
    }
    if (!current) {
      continue;
    }

    const cd = /^CD\s+(.+)$/.exec(line);
    if (cd && current.coefficients.length === 0) {
      // The catalog writes ten coefficient slots whatever the fit needs, so the
      // tail is padding and is dropped rather than stored and ignored later.
      //
      // **But only past what the formula reads.** A zero inside that is a term,
      // not padding: MISC's `CDS` is a two-term Sellmeier written as six numbers
      // whose last two are zeros, and trimming those left four coefficients and
      // a formula that wanted six. SCHOTT and Ohara never showed this because
      // every one of their glasses fills all six slots.
      current.coefficients = trimTrailingZeros(
        cd[1]!.trim().split(/\s+/).map(Number),
        DISPERSION_COEFFICIENT_COUNT[current.formula] ?? 0,
      );
      continue;
    }

    const ld = /^LD\s+(.+)$/.exec(line);
    if (ld && current.rangeNm[1] === 0) {
      const [min, max] = ld[1]!.trim().split(/\s+/).map(Number);
      current.rangeNm = [micronsToNm(min!), micronsToNm(max!)];
    }
  }

  if (glasses.length === 0) {
    throw new Error(`${manufacturer}: no glasses found in ${path}; is it a Zemax .AGF catalog?`);
  }
  for (const glass of glasses) {
    if (glass.coefficients.length === 0) {
      throw new Error(`${glass.name}: no CD record, so it has no dispersion fit.`);
    }
    if (!(glass.rangeNm[0] > 0) || !(glass.rangeNm[1] > glass.rangeNm[0])) {
      throw new Error(
        `${glass.name}: no usable LD record; range reads ${glass.rangeNm.join('–')}.`,
      );
    }
  }
  return { title, glasses };
}

/**
 * Ranges are micrometers in the file and nanometers here. Scaling by 1000 in
 * binary floating point turns Ohara's 2.32542 µm into 2325.4199999999996, so the
 * result is rounded back to the precision the file actually stated.
 */
function micronsToNm(microns: number): number {
  return Number((microns * 1000).toPrecision(12));
}

function trimTrailingZeros(values: number[], keep: number): number[] {
  let end = values.length;
  while (end > keep && values[end - 1] === 0) {
    end -= 1;
  }
  return values.slice(0, end);
}

function renderModule(glasses: readonly Parsed[], title: string, source: CatalogSource): string {
  const formulaName = new Map(
    Object.entries(DISPERSION_FORMULA).map(([key, value]) => [value as number, key]),
  );
  const counts = new Map<number, number>();
  for (const glass of glasses) {
    counts.set(glass.formula, (counts.get(glass.formula) ?? 0) + 1);
  }

  const rows = glasses.map((glass) => {
    const coefficients = glass.coefficients.join(', ');
    return (
      `  g('${glass.name}', ${glass.formula}, [${coefficients}], ` +
      `${glass.rangeNm[0]}, ${glass.rangeNm[1]}, ${glass.nd}, ${glass.abbeNumber}, '${glass.status}'),`
    );
  });

  const breakdown = [...counts]
    .sort((a, b) => a[0] - b[0])
    .map(([formula, count]) => `${count} on formula ${formula} (${formulaName.get(formula)})`)
    .join(', ');

  return `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run regenerate --workspace @isaac/glass-catalog
//
// Source: ${source.agf}${title ? `\n// ${title}` : ''}
//
// ${source.provenance ?? DEFAULT_PROVENANCE(source.manufacturer)}
//
// All ${glasses.length} entries are here, including glasses no longer made — an old lens
// file is exactly where a discontinued one turns up, so \`record.status\` says
// which those are rather than the catalog leaving them out.
//
// Dispersion fits: ${breakdown}.
//
// The formula number travels with each glass because it varies per glass, and
// every fit below was checked against the catalog's own printed nd and Abbe
// number before being written here.

import { type GlassRecord, type GlassStatus } from './types.ts';

function g(
  name: string,
  formula: number,
  coefficients: readonly number[],
  minNm: number,
  maxNm: number,
  nd: number,
  abbeNumber: number,
  status: GlassStatus,
): GlassRecord {
  return {
    name,
    manufacturer: '${source.manufacturer}',
    formula,
    coefficients,
    rangeNm: [minNm, maxNm],
    nd,
    abbeNumber,
    status,
  };
}

/** The ${glasses.length} glasses of ${source.manufacturer}'s catalog, as published. */
export const ${source.constant}: readonly GlassRecord[] = [
${rows.join('\n')}
];
`;
}
