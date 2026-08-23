/**
 * Regenerates `src/schott.ts` from SCHOTT's own Zemax-format catalog.
 *
 *   npm run regenerate --workspace @isaac/glass-catalog -- <path to .AGF>
 *
 * **The `.AGF` is the only source of glass data in this repo.** It comes from
 * the manufacturer, so the numbers here are the ones SCHOTT publishes rather
 * than a third party's transcription or refit of them. An earlier version of
 * this file pulled from refractiveindex.info; that is deliberately gone.
 *
 * The catalog is reproduced *as written*, all 366 entries. That includes ones
 * whose optical fits coincide — `BK7` and `N-BK7` are the same dispersion under
 * two names — because they are different products that happen to share their
 * optical properties, and mechanical data (thermal expansion, density) can
 * differ. Keeping the manufacturer's list intact also means no alias table: a
 * name either is in the catalog or is not.
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

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DISPERSION_FORMULA, dispersionMaterial } from '@isaac/optical-core';
import { GLASS_STATUS, type GlassStatus } from '../src/types.ts';

const D_LINE_NM = 587.5618;
const F_LINE_NM = 486.1327;
const C_LINE_NM = 656.2725;

/** How far a fit may miss the catalog's own printed nd / Vd before we refuse it. */
const ND_TOLERANCE = 5e-5;
const VD_TOLERANCE = 0.01;

const DEFAULT_AGF = fileURLToPath(
  new URL(
    '../../../SupportingMaterial/schott glasses preferred and special June-2025-B.AGF',
    import.meta.url,
  ),
);
const OUTPUT = fileURLToPath(new URL('../src/schott.ts', import.meta.url));

interface Parsed {
  name: string;
  formula: number;
  nd: number;
  abbeNumber: number;
  status: GlassStatus;
  coefficients: number[];
  rangeNm: [number, number];
}

const agfPath = process.argv[2] ?? DEFAULT_AGF;
const { title, glasses } = await readAgf(agfPath);
console.log(`Read ${glasses.length} glasses from ${title}`);

const byFormula = new Map<number, number>();
for (const glass of glasses) {
  byFormula.set(glass.formula, (byFormula.get(glass.formula) ?? 0) + 1);
}
console.log(
  `Dispersion formulas: ${[...byFormula]
    .sort((a, b) => a[0] - b[0])
    .map(([formula, count]) => `${formula}×${count}`)
    .join(', ')}`,
);

// Every fit must rebuild the catalog's own printed nd and Vd. This is the check
// that the coefficients were read out of the right columns and handed to the
// right equation — a Sellmeier fit read as a Schott one still returns numbers.
const wrong: string[] = [];
for (const glass of glasses) {
  const material = dispersionMaterial(glass.name, glass.formula, glass.coefficients);
  const nd = material.indexAt(D_LINE_NM);
  const vd = (nd - 1) / (material.indexAt(F_LINE_NM) - material.indexAt(C_LINE_NM));
  if (Math.abs(nd - glass.nd) > ND_TOLERANCE || Math.abs(vd - glass.abbeNumber) > VD_TOLERANCE) {
    wrong.push(
      `  ${glass.name}: fit gives nd ${nd.toFixed(6)} / Vd ${vd.toFixed(4)}, ` +
        `catalog prints ${glass.nd.toFixed(6)} / ${glass.abbeNumber.toFixed(4)}`,
    );
  }
}
if (wrong.length > 0) {
  throw new Error(
    `${wrong.length} glasses do not reproduce their printed nd/Vd:\n${wrong.join('\n')}`,
  );
}
console.log(`All ${glasses.length} fits reproduce the catalog's printed nd and Vd.`);

glasses.sort((a, b) => a.name.localeCompare(b.name));
await writeFile(OUTPUT, renderModule(glasses, title), 'utf8');
console.log(`Wrote ${OUTPUT}`);

async function readAgf(path: string): Promise<{ title: string; glasses: Parsed[] }> {
  // AGF files are Latin-1; a degree sign in a comment must not derail the parse,
  // and no name or number is outside ASCII.
  const text = (await readFile(path, 'latin1')).replace(/\r/g, '');
  const glasses: Parsed[] = [];
  let title = path;
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
      // The catalog pads the coefficient slots it does not use with zeros, and
      // pads to different widths for different glasses. Only the leading ones
      // the formula reads are meaningful, so the padding is dropped here rather
      // than stored and ignored later.
      current.coefficients = trimTrailingZeros(cd[1]!.trim().split(/\s+/).map(Number));
      continue;
    }

    const ld = /^LD\s+(.+)$/.exec(line);
    if (ld && current.rangeNm[1] === 0) {
      const [min, max] = ld[1]!.trim().split(/\s+/).map(Number);
      current.rangeNm = [min! * 1000, max! * 1000]; // µm in the file, nm here
    }
  }

  if (glasses.length === 0) {
    throw new Error(`No glasses found in ${path}; is it a Zemax .AGF catalog?`);
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

function trimTrailingZeros(values: number[]): number[] {
  let end = values.length;
  while (end > 0 && values[end - 1] === 0) {
    end -= 1;
  }
  return values.slice(0, end);
}

function renderModule(glasses: readonly Parsed[], title: string): string {
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
// Regenerate with: npm run regenerate --workspace @isaac/glass-catalog -- <path to .AGF>
//
// Source: ${title}
//
// SCHOTT's own Zemax-format catalog, reproduced entry for entry. It is the only
// source of glass data in this repo: the numbers below are the manufacturer's,
// not a third party's transcription of them.
//
// All ${glasses.length} entries are here, including names SCHOTT has retired. \`BK7\` and
// \`N-BK7\` both appear and carry the same dispersion — they are separate products
// whose optical properties coincide — so a lens file naming either resolves
// directly and no alias table is needed.
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
    manufacturer: 'SCHOTT',
    formula,
    coefficients,
    rangeNm: [minNm, maxNm],
    nd,
    abbeNumber,
    status,
  };
}

/** The ${glasses.length} glasses of SCHOTT's catalog, as published. */
export const SCHOTT_GLASSES: readonly GlassRecord[] = [
${rows.join('\n')}
];
`;
}
