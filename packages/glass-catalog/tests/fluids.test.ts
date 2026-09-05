import assert from 'node:assert/strict';
import test from 'node:test';
import { FLUID_MEDIA, fluidMedium, isSolid, ModelGlassMaterial } from '@isaac/optical-core';
import { ALL_GLASSES, MISC } from '../src/index.ts';

/**
 * `optical-core` names the media a lens sits *in* — water, seawater, immersion
 * oil, vacuum — so that the UI can tell a singlet in a tank from a cemented
 * doublet. It cannot depend on this package to look their numbers up, so it
 * carries a copy of them, and these tests are what stop that copy going stale:
 * `misc.ts` is generated from the manufacturer's own file, and a regeneration
 * that moved a value would otherwise leave the core quietly failing to
 * recognize a fluid written by its numbers.
 */
test('every fluid is a MISC record, and the numbers still agree with it', () => {
  const records = new Map(MISC.records().map((record) => [record.name, record]));
  for (const fluid of FLUID_MEDIA) {
    const record = records.get(fluid.name);
    assert.ok(record, `${fluid.name} is not in the MISC catalog`);
    assert.equal(record.nd, fluid.nd, `${fluid.name}: nd`);
    assert.equal(record.abbeNumber, fluid.abbeNumber, `${fluid.name}: Abbe number`);
  }
});

/**
 * The margin the identification rests on.
 *
 * A model glass carrying a fluid's numbers *is* that fluid — a design taken from
 * a paper has no glass names in it, so water arrives as 1.3330/55.79 and nothing
 * else. That is only safe while no glass anybody makes is near those numbers.
 * The tolerance is 1e-3 in nd and 0.5 in Vd; the nearest solid is 0.0175 and
 * 0.62 away, so there is better than an order of magnitude in hand. A future
 * catalog whose glass closed that gap should stop somebody and make them look,
 * which is what this asserts.
 */
test('no solid in any catalog is close enough to a fluid to be mistaken for one', () => {
  const fluidNames = new Set(FLUID_MEDIA.map((fluid) => fluid.name));
  const solids = ALL_GLASSES.records().filter((record) => !fluidNames.has(record.name));

  for (const fluid of FLUID_MEDIA) {
    for (const solid of solids) {
      const nd = Math.abs(solid.nd - fluid.nd);
      const abbe = Math.abs(solid.abbeNumber - fluid.abbeNumber);
      assert.ok(
        nd > 10e-3 || abbe > 5,
        `${solid.name} (${solid.manufacturer}) sits ${nd.toFixed(4)}/${abbe.toFixed(2)} from ${fluid.name}`,
      );
    }
  }
});

test('a fluid is recognized by its catalog name, however it is spelled', () => {
  for (const spelling of ['WATER', 'water', 'SEA WATER', 'sea_water', 'TypeA', 'VACUUM']) {
    const material = ALL_GLASSES.get(spelling.replace(/[\s_]/g, ''));
    assert.ok(material, `${spelling} is not in the catalog`);
    assert.ok(fluidMedium(material), `${material.name} was not recognized as a fluid`);
  }
});

/**
 * `Liang2002a.zmx`, a schematic eye, writes the vitreous humour this way — the
 * file names no glass at all, so the medium in front of the retina arrives as
 * `___BLANK 1.33304403094 55.7943215`. Those are MISC's own numbers for water to
 * every digit it prints, and without this the eye's lens and its vitreous read
 * as one cemented doublet.
 */
test("a model glass carrying water's numbers is water", () => {
  const vitreous = new ModelGlassMaterial('___BLANK 1.3330/55.79', 1.33304403094, 55.7943215);
  assert.equal(fluidMedium(vitreous)?.name, 'WATER');
  assert.equal(isSolid(vitreous, 587.5618), false);
});

/**
 * The numeric route applies only to a **model** glass — one that is nothing but
 * an index and an Abbe number, which is what a file writes when it has no glass
 * to name. A glass with a real dispersion fit behind it is a melt somebody sells
 * and is taken at its name, so no catalog entry can ever be unmade into oil by
 * arithmetic.
 */
test('a glass with a real fit is never re-read as a fluid', () => {
  for (const record of ALL_GLASSES.records()) {
    if (FLUID_MEDIA.some((fluid) => fluid.name === record.name)) {
      continue;
    }
    const material = ALL_GLASSES.get(record.name)!;
    assert.equal(
      fluidMedium(material),
      undefined,
      `${record.name} (${record.manufacturer}) was read as a fluid`,
    );
  }

  const nbk7 = ALL_GLASSES.get('N-BK7')!;
  assert.equal(isSolid(nbk7, 587.5618), true);
});
