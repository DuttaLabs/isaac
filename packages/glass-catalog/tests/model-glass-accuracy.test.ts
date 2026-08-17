import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelGlassMaterial,
  SPECTRAL_LINES,
  normalLinePartialDispersion,
} from '@isaac/optical-core';
import { SCHOTT } from '../src/index.ts';

/**
 * The model glass is an approximation, and the only honest way to say how good
 * it is at scale is to check it against every measured fit available: derive
 * (nd, Vd, ΔPg,F) from a real glass, rebuild it from those three numbers alone,
 * and measure the drift. These bounds are what the catalog actually delivers,
 * so a change that degrades the model fails here rather than silently shipping.
 */

const { d, F, C, g } = SPECTRAL_LINES;
const BAND = [400, 450, 486.1327, 500, 550, 587.5618, 600, 650, 656.2725, 700];

interface Measured {
  name: string;
  nd: number;
  vd: number;
  deltaPgF: number;
}

/** Every catalog glass whose published fit reaches the g line. */
function measuredGlasses(): Measured[] {
  const rows: Measured[] = [];
  for (const record of SCHOTT.records()) {
    const glass = SCHOTT.get(record.name)!;
    try {
      const nd = glass.indexAt(d);
      const vd = (nd - 1) / (glass.indexAt(F) - glass.indexAt(C));
      const pgf = (glass.indexAt(g) - glass.indexAt(F)) / (glass.indexAt(F) - glass.indexAt(C));
      rows.push({ name: record.name, nd, vd, deltaPgF: pgf - normalLinePartialDispersion(vd) });
    } catch {
      // The fit does not cover the g line, so there is no partial dispersion.
    }
  }
  return rows;
}

/** Worst and median absolute index error over the visible band. */
function drift(
  glasses: Measured[],
  useDeltaPgF: boolean,
): { median: number; worst: number; worstName: string } {
  const errors: number[] = [];
  let worst = 0;
  let worstName = '';

  for (const row of glasses) {
    const truth = SCHOTT.get(row.name)!;
    const model = new ModelGlassMaterial(row.name, row.nd, row.vd, {
      deltaPgF: useDeltaPgF ? row.deltaPgF : 0,
    });
    for (const nm of BAND) {
      let measured: number;
      try {
        measured = truth.indexAt(nm);
      } catch {
        continue; // outside this glass's published range
      }
      const error = Math.abs(model.indexAt(nm) - measured);
      errors.push(error);
      if (error > worst) {
        worst = error;
        worstName = row.name;
      }
    }
  }

  errors.sort((a, b) => a - b);
  return { median: errors[Math.floor(errors.length / 2)]!, worst, worstName };
}

test('the catalog supplies enough glasses to make this meaningful', () => {
  assert.ok(measuredGlasses().length > 150, 'expected the SCHOTT catalog to be loaded');
});

test('a model glass tracks a measured one to ~1e-4 across the visible', () => {
  const { median, worst, worstName } = drift(measuredGlasses(), true);

  // OpticStudio claims roughly 1e-4 for its own (proprietary) model glass, so
  // this is the same order of accuracy, arrived at from published optics.
  assert.ok(median < 5e-5, `median drift ${median}`);
  assert.ok(worst < 5e-4, `worst drift ${worst} on ${worstName}`);
});

test('omitting the partial dispersion costs an order of magnitude', () => {
  const withIt = drift(measuredGlasses(), true);
  const without = drift(measuredGlasses(), false);

  // This is why a file that gives only nd and Vd gets a cruder glass: the
  // import says so, and this pins the size of "cruder".
  assert.ok(without.worst > withIt.worst * 5, `${without.worst} vs ${withIt.worst}`);
  assert.ok(without.worst < 1e-2, `still usable for layout: ${without.worst}`);
});

test('every catalog glass sits near the normal line', () => {
  // ΔPg,F is a deviation, so it should be small for ordinary glasses and only
  // grow for the deliberately anomalous ones the line is defined against.
  const glasses = measuredGlasses();
  const typical = glasses.filter((row) => Math.abs(row.deltaPgF) < 0.02).length;

  assert.ok(typical / glasses.length > 0.6, `only ${typical}/${glasses.length} near the line`);
  assert.ok(
    glasses.every((row) => Math.abs(row.deltaPgF) < 0.1),
    'no glass should be far off',
  );
});
