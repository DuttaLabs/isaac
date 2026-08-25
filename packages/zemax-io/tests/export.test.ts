import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  AIR,
  ConstantMaterial,
  ModelGlassMaterial,
  N_BK7,
  OpticalSystem,
  Surface,
  type Material,
} from '@isaac/optical-core';
import { exportZmx, importZmx, parseZmxDocument, ZmxExportError } from '../src/index.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'doublet.zmx');

/** The fixture names SCHOTT BK7 and F2, which the core catalog does not carry. */
const SCHOTT: ReadonlyMap<string, Material> = new Map([
  ['BK7', new ConstantMaterial('BK7', 1.5168)],
  ['F2', new ConstantMaterial('F2', 1.62)],
  ['N-BK7', N_BK7],
]);
const resolveMaterial = (name: string): Material | undefined =>
  SCHOTT.get(name.trim().toUpperCase());

/** The fixture's doublet, with its glasses resolved. */
function doublet(): OpticalSystem {
  return importZmx(readFileSync(FIXTURE), { resolveMaterial }).system;
}

/** Everything the model holds, so a round trip is compared on all of it at once. */
function digest(system: OpticalSystem) {
  return {
    name: system.name,
    units: system.units,
    wavelengthsNm: [...system.wavelengthsNm],
    primaryWavelengthIndex: system.primaryWavelengthIndex,
    fields: system.fields.map((field) => ({ ...field })),
    aperture: system.aperture ?? null,
    surfaces: system.surfaces.map((surface) => ({
      type: surface.type,
      radius: surface.radius,
      conic: surface.conic,
      asphericCoefficients: [...surface.asphericCoefficients],
      thickness: surface.thickness,
      semiDiameter: surface.semiDiameter,
      focalLength: surface.focalLength ?? null,
      coordinateTransform: surface.coordinateTransform ?? null,
      material: surface.material.name,
      reflective: surface.reflective,
      isStop: surface.isStop,
      comment: surface.comment ?? null,
    })),
  };
}

function reread(system: OpticalSystem): OpticalSystem {
  return importZmx(exportZmx(system).text, { resolveMaterial }).system;
}

/** Asserts that writing a system and reading it back changes nothing about it. */
function assertRoundTrips(system: OpticalSystem) {
  assert.deepStrictEqual(digest(reread(system)), digest(system));
}

test('a file read, written, and read again is the same system', () => {
  assertRoundTrips(doublet());
});

test('the written file parses as a document with the surfaces in order', () => {
  const system = doublet();
  const document = parseZmxDocument(exportZmx(system).text);

  assert.equal(document.surfaces.length, system.surfaces.length);
  assert.deepStrictEqual(
    document.surfaces.map((block) => block.number),
    system.surfaces.map((_, index) => index),
  );
  // Indentation is the only cue for where the surface list ends, so a trailer
  // record must be flush left and a surface record must not be.
  const text = exportZmx(system).text;
  assert.match(text, /^MNUM 1$/m);
  assert.match(text, /^ {2}TYPE STANDARD$/m);
});

test('no VERS record: Isaac is not a version of Zemax', () => {
  const system = doublet();
  const document = parseZmxDocument(exportZmx(system).text);

  assert.equal(
    document.header.some((record) => record.token === 'VERS'),
    false,
  );
  // Provenance goes where it is true.
  assert.ok(document.header.some((record) => record.token === 'NOTE'));
});

test('the glass catalogs are the caller’s to name, not this package’s to guess', () => {
  const system = doublet();

  const without = parseZmxDocument(exportZmx(system).text);
  assert.equal(
    without.header.some((record) => record.token === 'GCAT'),
    false,
  );

  const withCatalogs = parseZmxDocument(
    exportZmx(system, { glassCatalogs: ['SCHOTT', 'OHARA'] }).text,
  );
  const gcat = withCatalogs.header.find((record) => record.token === 'GCAT');
  assert.deepStrictEqual(gcat?.values, ['SCHOTT', 'OHARA']);
});

test('a mirror goes out as GLAS MIRROR and comes back reflective', () => {
  const system = new OpticalSystem({
    name: 'Two-mirror',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 100 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'primary',
        type: 'STANDARD',
        radius: -1000,
        // Negative: after a reflection, +Z runs against the light.
        thickness: -400,
        semiDiameter: 50,
        reflective: true,
        isStop: true,
      }),
      new Surface({
        id: 'secondary',
        type: 'STANDARD',
        radius: -300,
        thickness: 500,
        semiDiameter: 15,
        reflective: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const text = exportZmx(system).text;
  assert.match(text, /GLAS MIRROR/);
  assertRoundTrips(system);

  // The thickness after a mirror is negative, and stays that way in the file.
  assert.match(text, /DISZ -400/);
});

test('a coordinate transform writes its six parameters and no glass', () => {
  const system = new OpticalSystem({
    name: 'Folded',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'break',
        type: 'COORDINATE_TRANSFORM',
        thickness: 5,
        coordinateTransform: {
          decenterX: 1.5,
          decenterY: -2.25,
          tiltXDeg: 45,
          tiltYDeg: 0,
          tiltZDeg: 10,
          tiltFirst: true,
        },
      }),
      new Surface({ id: 's', type: 'STANDARD', radius: 50, thickness: 20, semiDiameter: 5 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const document = parseZmxDocument(exportZmx(system).text);
  const block = document.surfaces[1]!;
  assert.equal(block.records.find((r) => r.token === 'TYPE')?.values[0], 'COORDBRK');
  assert.deepStrictEqual(
    block.records.filter((r) => r.token === 'PARM').map((r) => r.values.join(' ')),
    ['1 1.5', '2 -2.25', '3 45', '4 0', '5 10', '6 1'],
  );
  // A transform cannot be a boundary between media, so it names no glass.
  assert.equal(
    block.records.some((r) => r.token === 'GLAS'),
    false,
  );

  assertRoundTrips(system);
});

test('an even asphere writes PARM 1 as the r² coefficient', () => {
  const coefficients = [1e-5, -2e-7, 3e-9, 0, 5e-14];
  const system = new OpticalSystem({
    name: 'Asphere',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'a',
        type: 'EVEN_ASPHERE',
        radius: 40,
        conic: -1.5,
        asphericCoefficients: coefficients,
        thickness: 30,
        semiDiameter: 5,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const document = parseZmxDocument(exportZmx(system).text);
  const block = document.surfaces[1]!;
  assert.equal(block.records.find((r) => r.token === 'TYPE')?.values[0], 'EVENASPH');
  // The series starts at r², so α₁ is PARM 1 — an off-by-one here is a
  // different lens that still traces and still looks like a lens.
  assert.equal(block.records.find((r) => r.token === 'PARM')?.values.join(' '), '1 0.00001');
  assert.equal(block.records.find((r) => r.token === 'CONI')?.values[0], '-1.5');

  assertRoundTrips(system);
});

test('a paraxial surface writes its focal length as PARM 1', () => {
  const system = new OpticalSystem({
    name: 'Ideal',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'p',
        type: 'PARAXIAL',
        focalLength: 75,
        thickness: 75,
        semiDiameter: 5,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const document = parseZmxDocument(exportZmx(system).text);
  const block = document.surfaces[1]!;
  assert.equal(block.records.find((r) => r.token === 'TYPE')?.values[0], 'PARAXIAL');
  assert.equal(block.records.find((r) => r.token === 'PARM')?.values.join(' '), '1 75');

  assertRoundTrips(system);
});

test('a model glass goes back out as ___BLANK with its index and Abbe number', () => {
  const modelGlass = new ModelGlassMaterial('___BLANK 1.6200/60.30', 1.62, 60.3);
  const system = new OpticalSystem({
    name: 'Patent glass',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'a',
        type: 'STANDARD',
        radius: 50,
        thickness: 4,
        semiDiameter: 5,
        material: modelGlass,
        isStop: true,
      }),
      new Surface({ id: 'b', type: 'STANDARD', radius: -50, thickness: 45, semiDiameter: 5 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const glas = parseZmxDocument(exportZmx(system).text).surfaces[1]!.records.find(
    (r) => r.token === 'GLAS',
  )!;
  // name, code (1 = model), pickup surface, nd, Vd — the manual's column order.
  assert.equal(glas.values[0], '___BLANK');
  assert.equal(glas.values[1], '1');
  assert.equal(glas.values[3], '1.62');
  assert.equal(glas.values[4], '60.3');

  const back = reread(system).surfaces[1]!.material;
  assert.ok(back instanceof ModelGlassMaterial);
  assert.equal(back.nd, 1.62);
  assert.equal(back.abbeNumber, 60.3);
});

test('a glass given an index but no dispersion keeps its Vd of zero', () => {
  // Vd = 0 is not an Abbe number — it is the file saying there is no dispersion.
  const system = new OpticalSystem({
    name: 'Index only',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'a',
        type: 'STANDARD',
        radius: 50,
        thickness: 4,
        semiDiameter: 5,
        material: new ConstantMaterial('___BLANK n=1.5000', 1.5),
        isStop: true,
      }),
      new Surface({ id: 'b', type: 'STANDARD', radius: -50, thickness: 45, semiDiameter: 5 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const glas = parseZmxDocument(exportZmx(system).text).surfaces[1]!.records.find(
    (r) => r.token === 'GLAS',
  )!;
  assert.equal(glas.values[3], '1.5');
  assert.equal(glas.values[4], '0');

  const back = reread(system).surfaces[1]!.material;
  assert.equal(back.indexAt(587.5618), 1.5);
});

test('a model glass with a partial-dispersion deviation is written and warned about', () => {
  const system = new OpticalSystem({
    name: 'Off the normal line',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'a',
        type: 'STANDARD',
        radius: 50,
        thickness: 4,
        semiDiameter: 5,
        material: new ModelGlassMaterial('___BLANK 1.6200/60.30/0.0120', 1.62, 60.3, {
          deltaPgF: 0.012,
        }),
        isStop: true,
      }),
      new Surface({ id: 'b', type: 'STANDARD', radius: -50, thickness: 45, semiDiameter: 5 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const written = exportZmx(system);
  const glas = parseZmxDocument(written.text).surfaces[1]!.records.find((r) => r.token === 'GLAS')!;
  // Written into the partial-dispersion column rather than dropped: another
  // program gets the glass the designer specified.
  assert.equal(glas.values[5], '0.012');

  // And said out loud, because this reader deliberately ignores that column, so
  // reopening the file here puts the glass back on the normal line.
  assert.equal(written.warnings.length, 1);
  assert.match(written.warnings[0]!, /normal line/);
  assert.equal((reread(system).surfaces[1]!.material as ModelGlassMaterial).deltaPgF, 0);
});

test('a name or comment holding a newline cannot corrupt the file', () => {
  // A record is one line and whitespace-delimited, so an unescaped newline would
  // end it and read the rest back as stray tokens — a broken file from a
  // character nobody meant to type.
  const system = new OpticalSystem({
    name: 'Double\nGauss   28 degree',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'a',
        type: 'STANDARD',
        radius: 50,
        thickness: 45,
        semiDiameter: 10,
        isStop: true,
        comment: 'front\nelement',
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });

  const text = exportZmx(system).text;
  const document = parseZmxDocument(text);
  // One NAME record and one COMM record, not two of each plus a stray token.
  assert.equal(document.header.filter((r) => r.token === 'NAME').length, 1);
  assert.equal(document.surfaces[1]!.records.filter((r) => r.token === 'COMM').length, 1);

  const back = importZmx(text, { resolveMaterial }).system;
  assert.equal(back.name, 'Double Gauss 28 degree');
  assert.equal(back.surfaces[1]!.comment, 'front element');
});

test('an ordinary system is written with nothing to warn about', () => {
  assert.deepStrictEqual(exportZmx(doublet()).warnings, []);
});

test('an unlimited semi-diameter is written as DIAM 0, which means no aperture', () => {
  const system = new OpticalSystem({
    name: 'Open',
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 'a', type: 'STANDARD', radius: 50, thickness: 45, isStop: true }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
  assert.equal(system.surfaces[1]!.semiDiameter, Infinity);

  const diam = parseZmxDocument(exportZmx(system).text).surfaces[1]!.records.find(
    (r) => r.token === 'DIAM',
  )!;
  assert.equal(diam.values[0], '0');
  assert.equal(reread(system).surfaces[1]!.semiDiameter, Infinity);
});

test('an object at infinity writes DISZ INFINITY', () => {
  const system = doublet();
  assert.match(exportZmx(system).text, /DISZ INFINITY/);
});

test('every aperture type survives the trip', () => {
  const apertures = [
    { type: 'ENTRANCE_PUPIL_DIAMETER', value: 12.5 },
    { type: 'IMAGE_SPACE_FNUM', value: 2.8 },
    { type: 'OBJECT_SPACE_NA', value: 0.25 },
    { type: 'FLOAT_BY_STOP' },
  ] as const;

  for (const aperture of apertures) {
    const system = new OpticalSystem({
      name: `Aperture ${aperture.type}`,
      fields: [{ angleDeg: 0 }],
      aperture,
      surfaces: [
        new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
        new Surface({
          id: 'a',
          type: 'STANDARD',
          radius: 50,
          thickness: 45,
          semiDiameter: 10,
          material: N_BK7,
          isStop: true,
        }),
        new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
      ],
    });
    assert.deepStrictEqual(reread(system).aperture, system.aperture, aperture.type);
  }
});

test('object-height fields and their unit survive the trip', () => {
  for (const units of ['mm', 'cm', 'm', 'in'] as const) {
    const system = new OpticalSystem({
      name: 'Finite conjugate',
      units,
      fields: [{ objectHeight: 0 }, { objectHeight: -5.5 }],
      aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
      surfaces: [
        new Surface({ id: 'obj', type: 'OBJECT', thickness: 200, material: AIR }),
        new Surface({
          id: 'a',
          type: 'STANDARD',
          radius: 50,
          thickness: 60,
          semiDiameter: 10,
          isStop: true,
        }),
        new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
      ],
    });
    assertRoundTrips(system);
  }
});

test('a system mixing angle and height fields is refused, not written wrong', () => {
  // A file has one field type for the whole system, so there is no honest way to
  // write both; a silent choice would read half the fields back in the wrong unit.
  const system = new OpticalSystem({
    name: 'Mixed',
    fields: [{ angleDeg: 5 }, { objectHeight: 10 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'a',
        type: 'STANDARD',
        radius: 50,
        thickness: 45,
        semiDiameter: 10,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });

  assert.throws(() => exportZmx(system).text, ZmxExportError);
});

test('full double precision survives, so nothing is lost to formatting', () => {
  const radius = 92.84712345678901;
  const thickness = 6.000000000000001;
  const system = new OpticalSystem({
    name: 'Precision',
    wavelengthsNm: [486.1327, 587.5618, 656.2725],
    primaryWavelengthIndex: 1,
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'a',
        type: 'STANDARD',
        radius,
        thickness,
        semiDiameter: 15,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });

  const back = reread(system);
  // Radius goes out as a curvature and comes back inverted, so it is the one
  // number that cannot be compared bit for bit.
  assert.ok(Math.abs(back.surfaces[1]!.radius - radius) < 1e-12);
  assert.equal(back.surfaces[1]!.thickness, thickness);
  assert.deepStrictEqual([...back.wavelengthsNm], [...system.wavelengthsNm]);
});

test('the stop, the comment and the surface order all survive', () => {
  const system = doublet();
  const withNotes = system
    .withSurfaceAt(1, system.surfaceAt(1).with({ comment: 'Crown front' }))
    .withSurfaceAt(3, system.surfaceAt(3).with({ comment: 'Flint rear' }));

  const back = reread(withNotes);
  assert.equal(back.stopIndex, withNotes.stopIndex);
  assert.equal(back.surfaces[1]!.comment, 'Crown front');
  assert.equal(back.surfaces[3]!.comment, 'Flint rear');
});
