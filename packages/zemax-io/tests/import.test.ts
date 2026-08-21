import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ConstantMaterial,
  generateRayFan,
  paraxialProperties,
  traceRays,
  type Material,
} from '@isaac/optical-core';
import { UNKNOWN_GLASS_INDEX, ZmxImportError, importZmx } from '../src/index.ts';

const DOUBLET = readFileSync(
  fileURLToPath(new URL('./fixtures/doublet.zmx', import.meta.url)),
  'utf8',
);

/** The file names SCHOTT BK7 and F2, which the core catalog does not carry. */
const SCHOTT: ReadonlyMap<string, Material> = new Map([
  ['BK7', new ConstantMaterial('BK7', 1.5168)],
  ['F2', new ConstantMaterial('F2', 1.62)],
]);
const resolveMaterial = (name: string): Material | undefined =>
  SCHOTT.get(name.trim().toUpperCase());

function importDoublet(overrides = DOUBLET) {
  return importZmx(overrides, { resolveMaterial });
}

test('a doublet file maps onto the optical-core model', () => {
  const { system, warnings } = importDoublet();

  assert.equal(system.name, 'A SIMPLE DOUBLET USING A CROWN AND A FLINT.');
  assert.equal(system.units, 'mm');
  assert.deepEqual(system.aperture, { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 });
  assert.equal(system.stopIndex, 1);
  assert.deepEqual(warnings, []);

  // FTYP declares 3 wavelengths, so the file's padding entries are dropped,
  // and PWAV 2 selects the middle one. WAVM is in micrometers.
  assert.deepEqual(system.wavelengthsNm, [486, 589, 656]);
  assert.equal(system.primaryWavelengthNm, 589);

  // FTYP field type 0 = angle, 1 field.
  assert.deepEqual(system.fields, [{ angleDeg: 0 }]);
});

test('surface records become surfaces, with curvature inverted to radius', () => {
  const { system } = importDoublet();
  const [object, crown, flint, back, image] = system.surfaces;

  assert.equal(object!.type, 'OBJECT');
  assert.equal(object!.thickness, Infinity); // DISZ INFINITY
  assert.equal(object!.semiDiameter, Infinity); // DIAM 0 means "no aperture", not zero
  assert.equal(object!.radius, Infinity); // CURV 0

  assert.ok(Math.abs(crown!.radius - 1 / 1.0770399607790001e-2) < 1e-9);
  assert.equal(crown!.thickness, 6);
  assert.equal(crown!.semiDiameter, 15); // DIAM is the semi-diameter
  assert.equal(crown!.material.name, 'BK7');
  assert.equal(crown!.isStop, true);

  assert.ok(flint!.radius < 0);
  assert.equal(flint!.material.name, 'F2');
  assert.equal(back!.material.name, 'AIR'); // no GLAS record ⇒ air after the surface

  assert.equal(image!.type, 'IMAGE');
  assert.equal(image!.thickness, 0);
});

test('the imported system reproduces the file’s own back focal distance', () => {
  const { system } = importDoublet();
  const properties = paraxialProperties(system);

  // A 100 mm achromat: the file's last thickness (97.376) is its back focus.
  assert.ok(Math.abs(properties.effectiveFocalLength - 100) < 0.05);
  assert.ok(
    Math.abs(properties.backFocalDistance - 97.37604742911) < 0.05,
    `computed BFD ${properties.backFocalDistance}, file says 97.376`,
  );
  assert.ok(Math.abs(properties.imageSurfaceZ - properties.paraxialImageZ) < 0.05);
});

test('rays trace through the imported system to a real focus', () => {
  const { system } = importDoublet();
  const results = traceRays(system, generateRayFan(system, { count: 9 }));

  assert.ok(results.every((result) => result.status === 'TERMINATED'));
  const spread = Math.max(...results.map((result) => Math.abs(result.finalRay.origin.y)));
  assert.ok(spread < 0.01, `f/5 achromat should focus tightly; spread was ${spread} mm`);
});

test('unresolved glass fails the import unless explicitly allowed', () => {
  assert.throws(
    () => importZmx(DOUBLET),
    (error: unknown) => {
      assert.ok(error instanceof ZmxImportError);
      assert.match(error.message, /Unknown glass "BK7" on surface 1/);
      return true;
    },
  );

  const { system, warnings, glasses } = importZmx(DOUBLET, { allowUnknownGlass: true });
  assert.equal(system.surfaceAt(1).material.indexAt(589), UNKNOWN_GLASS_INDEX);
  assert.ok(warnings.some((warning) => /will not trace correctly/.test(warning)));
  assert.deepEqual(glasses, [
    { name: 'BK7', surfaceNumber: 1, resolved: false },
    { name: 'F2', surfaceNumber: 2, resolved: false },
  ]);
});

test('resolved glasses are reported alongside the system', () => {
  const { glasses } = importDoublet();
  assert.deepEqual(glasses, [
    { name: 'BK7', surfaceNumber: 1, resolved: true },
    { name: 'F2', surfaceNumber: 2, resolved: true },
  ]);
});

test('a glass the resolver substitutes is reported once, not left implicit', () => {
  // A catalog answering "SK16" with its lead-free replacement is making an
  // approximation, so the import must say so even though the lookup succeeded.
  const substituting = (name: string): Material | undefined =>
    name.trim().toUpperCase() === 'BK7'
      ? new ConstantMaterial('N-BK7', 1.5168)
      : resolveMaterial(name);
  const { warnings, glasses } = importZmx(DOUBLET, { resolveMaterial: substituting });

  assert.deepEqual(glasses[0], {
    name: 'BK7',
    surfaceNumber: 1,
    resolved: true,
    resolvedAs: 'N-BK7',
  });
  assert.equal(glasses[1]!.resolvedAs, undefined); // F2 resolved to F2
  const substitutions = warnings.filter((warning) => /is a substitute/.test(warning));
  assert.equal(substitutions.length, 1);
  assert.match(substitutions[0]!, /"BK7" is not in the catalog and was traced as "N-BK7"/);

  // Case and separators are spelling, not substitution: catalogs answer
  // "BK7" with "bk-7" and "F2" with "f 2" without changing the glass.
  const spelled = (name: string): Material | undefined =>
    new ConstantMaterial(name.trim().toLowerCase().replace(/(\d)/, '-$1'), 1.5);
  assert.deepEqual(importZmx(DOUBLET, { resolveMaterial: spelled }).warnings, []);
});

test('a glass described inline becomes a model glass', () => {
  // How a design taken from a patent names its glass: an index and an Abbe
  // number, no catalog entry. 1.5168/64.17 is N-BK7 described rather than named.
  const modeled = DOUBLET.replace(
    'GLAS BK7 0 0 0 0 0 0 0 0 0 0',
    'GLAS ___BLANK 1 0 1.5168 6.417E+1 0 0 0 0 0 0',
  );
  const { system, glasses, warnings } = importZmx(modeled, { resolveMaterial });

  assert.deepEqual(glasses[0], {
    name: '___BLANK 1.5168/64.17',
    surfaceNumber: 1,
    resolved: true,
    isModelGlass: true,
  });

  const glass = system.surfaceAt(1).material;
  assert.ok(Math.abs(glass.indexAt(587.5618) - 1.5168) < 1e-12);
  assert.ok(glass.indexAt(486.1327) > glass.indexAt(656.2725), 'must disperse the right way');
  assert.ok(warnings.some((warning) => /model glass/.test(warning)));
});

test('a model glass with no dispersion is traced as non-dispersive', () => {
  // Vd = 0 cannot be an Abbe number, so it means the file gave only an index.
  const flat = DOUBLET.replace(
    'GLAS BK7 0 0 0 0 0 0 0 0 0 0',
    'GLAS ___BLANK 1 0 1.56049116 0 0 0 0 0 0 0',
  );
  const { system, glasses, warnings } = importZmx(flat, { resolveMaterial });

  assert.equal(glasses[0]!.isNonDispersive, true);
  const glass = system.surfaceAt(1).material;
  assert.equal(glass.indexAt(486.1327), glass.indexAt(656.2725));
  assert.ok(warnings.some((warning) => /no dispersion \(Vd = 0\)/.test(warning)));
});

test('model glasses are reported once, however many surfaces use them', () => {
  const both = DOUBLET.replace(
    'GLAS BK7 0 0 0 0 0 0 0 0 0 0',
    'GLAS ___BLANK 1 0 1.5168 6.417E+1 0',
  ).replace('GLAS F2 0 0 0 0 0 0 0 0 0 0', 'GLAS ___BLANK 1 0 1.62 3.637E+1 0');
  const { warnings } = importZmx(both, { resolveMaterial });

  const reports = warnings.filter((warning) => /use a model glass/.test(warning));
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /2 surfaces/);
});

test('a model glass without usable numbers is refused, not guessed at', () => {
  assert.throws(
    () =>
      importZmx(DOUBLET.replace('GLAS BK7 0 0 0 0 0 0 0 0 0 0', 'GLAS ___BLANK 1 0'), {
        resolveMaterial,
      }),
    /model glass with no usable index and Abbe number/,
  );
});

test('surface records that would change the geometry become warnings', () => {
  // CLAP is a second, tighter aperture on the surface: ignoring it silently
  // would trace rays the real lens vignettes away.
  const withClap = importDoublet(
    DOUBLET.replace(
      '  DIAM 1.5E+1 1 0 0 1 ""\n  FLAP',
      '  CLAP 0 5.0 0\n  DIAM 1.5E+1 1 0 0 1 ""\n  FLAP',
    ),
  );
  assert.ok(
    withClap.warnings.some((warning) => /Surface 1 has a CLAP record/.test(warning)),
    `expected a CLAP warning, got ${JSON.stringify(withClap.warnings)}`,
  );

  // Records that only annotate the surface stay quiet.
  assert.deepEqual(importDoublet().warnings, []);
});

test('header settings that change how rays are launched become warnings', () => {
  const vignetted = importDoublet(DOUBLET.replace('VDYN 0 0 0', 'VDYN 0.2 0 0'));
  assert.ok(
    vignetted.warnings.some((warning) => /Vignetting factors are set \(VDYN\)/.test(warning)),
  );

  // RAIM's leading value is a dead `tol` placeholder, so a non-zero there is *not* ray aiming;
  // the mode is the second value. Both halves are pinned, since reading the wrong column
  // silently disables this warning on every real file (they all carry tol = 0).
  const notAimed = importDoublet(DOUBLET.replace('RAIM 0 0 1', 'RAIM 1 0 1'));
  assert.ok(!notAimed.warnings.some((warning) => /ray aiming/.test(warning)));

  const aimed = importDoublet(DOUBLET.replace('RAIM 0 0 1', 'RAIM 0 2 1'));
  assert.ok(aimed.warnings.some((warning) => /requests real ray aiming \(RAIM 2\)/.test(warning)));

  // The file's own ENVD is the standard environment, which the catalog
  // indices already assume, so only a departure from it is reported.
  const hot = importDoublet(DOUBLET.replace('ENVD 2.0E+1 1 0', 'ENVD 5.0E+1 1 0'));
  assert.ok(
    hot.warnings.some((warning) => /non-standard environment \(50 °C, 1 atm\)/.test(warning)),
  );
});

test('tokens the reader does not interpret are reported, not silently dropped', () => {
  const { ignoredTokens } = importDoublet();

  for (const token of ['HIDE', 'MIRR', 'FLAP', 'GCAT', 'VERS', 'TOL', 'MNUM']) {
    assert.ok(ignoredTokens.includes(token), `expected ${token} to be reported as ignored`);
  }
  // Interpreted tokens must not appear in the ignored list.
  for (const token of ['CURV', 'DISZ', 'DIAM', 'GLAS', 'STOP', 'ENPD', 'WAVM']) {
    assert.ok(!ignoredTokens.includes(token));
  }
});

test('geometry the core cannot model is rejected rather than approximated', () => {
  assert.throws(() => importDoublet(DOUBLET.replace('MODE SEQ', 'MODE NONSEQ')), /Only sequential/);
  assert.throws(
    () =>
      importDoublet(
        DOUBLET.replace('  TYPE STANDARD\n  CURV 1.07', '  TYPE TOROIDAL\n  CURV 1.07'),
      ),
    /only STANDARD, PARAXIAL, EVENASPH surfaces/,
  );
  assert.throws(
    () => importDoublet('MODE SEQ\nSURF 0\n  DISZ 0\n'),
    /at least an object and an image/,
  );
});

test('ambiguous or unsupported header data becomes a warning', () => {
  // Two aperture records: the first in file order wins, and the clash is reported.
  const twoApertures = importDoublet(DOUBLET.replace('ENPD 2.0E+1', 'ENPD 2.0E+1\nFNUM 5.0'));
  assert.deepEqual(twoApertures.system.aperture, { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 });
  assert.ok(twoApertures.warnings.some((warning) => /Several aperture records/.test(warning)));

  // Field type 3 is a real image height, which the core cannot express.
  const imageHeightFields = importDoublet(DOUBLET.replace('FTYP 0 0 1 3', 'FTYP 3 0 1 3'));
  assert.deepEqual(imageHeightFields.system.fields, []);
  assert.ok(imageHeightFields.warnings.some((warning) => /Field type 3/.test(warning)));

  // A stop marked on the image surface cannot be honored.
  const stopOnImage = importDoublet(DOUBLET.replace('SURF 4\n  TYPE', 'SURF 4\n  STOP\n  TYPE'));
  assert.equal(stopOnImage.system.stopIndex, 1); // still surface 1
  assert.ok(
    stopOnImage.warnings.some((warning) => /marked STOP but is the IMAGE surface/.test(warning)),
  );

  const oddUnits = importDoublet(DOUBLET.replace('UNIT MM', 'UNIT FURLONG'));
  assert.equal(oddUnits.system.units, 'mm');
  assert.ok(oddUnits.warnings.some((warning) => /Unrecognized UNIT/.test(warning)));
});

test('a file supplied as raw UTF-16 bytes imports identically', () => {
  const bytes = new Uint8Array((DOUBLET.length + 1) * 2);
  const withBom = `﻿${DOUBLET}`;
  for (let i = 0; i < withBom.length; i += 1) {
    const code = withBom.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }

  const fromBytes = importZmx(bytes, { resolveMaterial });
  assert.equal(fromBytes.system.name, importDoublet().system.name);
  assert.equal(fromBytes.system.surfaces.length, 5);
});

test('a conic constant is read onto the surface it shapes', () => {
  const { system, warnings, ignoredTokens } = importDoublet(
    DOUBLET.replace('  DISZ 6.0', '  CONI -1.0\n  DISZ 6.0'),
  );
  assert.equal(system.surfaceAt(1).conic, -1);
  assert.equal(system.surfaceAt(2).conic, 0);
  assert.deepEqual(warnings, []);
  assert.ok(!ignoredTokens.includes('CONI'));

  // A conic changes the shape but not the first-order layout, so the file's own
  // back focal distance must survive it untouched.
  assert.equal(
    paraxialProperties(system).backFocalDistance,
    paraxialProperties(importDoublet().system).backFocalDistance,
  );
});

test('an even asphere reads its coefficients from PARM 1 upward, starting at r²', () => {
  // PARM 1 is the coefficient on r², not r⁴ — the whole series is shifted one
  // power from what the column number suggests, so a file written with only
  // PARM 2 set must produce [0, α₂] and not [α₂].
  const { system, warnings, ignoredTokens } = importDoublet(
    DOUBLET.replace(
      '  TYPE STANDARD\n  CURV 1.07',
      '  TYPE EVENASPH\n  PARM 2 -3.5E-6\n  PARM 4 1.25E-9\n  CURV 1.07',
    ),
  );

  const front = system.surfaceAt(1);
  assert.equal(front.type, 'EVEN_ASPHERE');
  assert.deepEqual([...front.asphericCoefficients], [0, -3.5e-6, 0, 1.25e-9]);
  // With α₁ zero the vertex curvature is untouched, so the power is the sphere's.
  assert.equal(front.paraxialCurvature, front.curvature);
  assert.deepEqual(warnings, []);
  // PARM means something on this surface type, so it is no longer just ignored.
  assert.ok(!ignoredTokens.includes('PARM'));
});

test('an even asphere refuses a parameter column whose meaning is unverified', () => {
  assert.throws(
    () =>
      importDoublet(
        DOUBLET.replace(
          '  TYPE STANDARD\n  CURV 1.07',
          '  TYPE EVENASPH\n  PARM 9 1E-9\n  CURV 1.07',
        ),
      ),
    /unrecognized PARM 9/,
  );
});

test('GLAS MIRROR makes a surface reflective and leaves the medium alone', () => {
  // A mirror named where a glass would be. The medium on the far side is never
  // written in the file, because a mirror does not change it — so the reader has
  // to take it from the surface before, and here that is the crown glass.
  const { system, warnings, glasses } = importDoublet(
    DOUBLET.replace('  GLAS F2', '  GLAS MIRROR'),
  );

  const mirror = system.surfaceAt(2);
  assert.equal(mirror.reflective, true);
  assert.equal(mirror.material.name, system.surfaceAt(1).material.name);
  // MIRROR is not a glass, so it must not be reported as one — resolved or not.
  assert.ok(!glasses.some((glass) => /MIRROR/i.test(glass.name)));
  assert.deepEqual(warnings, []);
});

test('a mirror in air keeps air, and two in a row each take the medium before', () => {
  const doubled = importDoublet(
    DOUBLET.replace('  GLAS BK7', '  GLAS MIRROR').replace('  GLAS F2', '  GLAS MIRROR'),
  ).system;

  assert.equal(doubled.surfaceAt(1).reflective, true);
  assert.equal(doubled.surfaceAt(2).reflective, true);
  // Surface 1's medium before is the object's (air); surface 2 then adopts what
  // surface 1 was given, which is the same air. The forward pass is what makes
  // the second one work without a special case.
  assert.equal(doubled.surfaceAt(1).material.name, 'AIR');
  assert.equal(doubled.surfaceAt(2).material.name, 'AIR');
});

test('a mirror on the object or image surface is refused rather than ignored', () => {
  assert.throws(
    () =>
      importDoublet(
        DOUBLET.replace('SURF 0\n  TYPE STANDARD', 'SURF 0\n  TYPE STANDARD\n  GLAS MIRROR'),
      ),
    /GLAS MIRROR but is the object surface/,
  );
});

test('UNIT METER is meters, which is how the corpus spells it', () => {
  // Three of OpticStudio's samples write METER; none writes M. Getting this
  // wrong does not move a ray, but it labels every length in the UI as a
  // millimetre when it is a metre.
  assert.equal(importDoublet(DOUBLET.replace('UNIT MM', 'UNIT METER')).system.units, 'm');
  const warned = importDoublet(DOUBLET.replace('UNIT MM', 'UNIT FURLONG'));
  assert.equal(warned.system.units, 'mm');
  assert.ok(warned.warnings.some((warning) => /FURLONG/.test(warning)));
});
