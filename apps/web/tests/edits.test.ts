import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, N_BK7, OpticalSystem, Surface } from '@isaac/optical-core';
import {
  insertSurfaceAfter,
  insertSurfaceBefore,
  renameSystem,
  setMirror,
  setSurfaceType,
  updateSurface,
} from '../src/lib/edits.ts';

function singlet(front: Surface): OpticalSystem {
  return new OpticalSystem({
    name: 'singlet',
    wavelengthsNm: [587.5618],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      front,
      new Surface({ id: 's2', type: 'STANDARD', radius: -60, thickness: 50, semiDiameter: 8 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
}

const spherical = new Surface({
  id: 's1',
  type: 'STANDARD',
  radius: 40,
  conic: -0.6,
  thickness: 5,
  semiDiameter: 8,
  material: N_BK7,
  isStop: true,
});

test('making a surface aspheric keeps the shape it already had', () => {
  const result = setSurfaceType(singlet(spherical), 1, 'EVEN_ASPHERE');
  assert.ok(result.ok);
  const surface = result.value.surfaceAt(1);
  assert.equal(surface.type, 'EVEN_ASPHERE');
  // The radius and conic must survive: the designer is adding terms to a surface
  // they have already shaped, not starting a new one.
  assert.equal(surface.radius, 40);
  assert.equal(surface.conic, -0.6);
  assert.equal(surface.isStop, true);
  assert.equal(surface.material.name, N_BK7.name);
});

test('going back to spherical drops the coefficients and keeps everything else', () => {
  const aspheric = spherical.with({
    type: 'EVEN_ASPHERE',
    asphericCoefficients: [0, 2.5e-6, -1e-9],
  });
  const result = setSurfaceType(singlet(aspheric), 1, 'STANDARD');
  assert.ok(result.ok);
  const surface = result.value.surfaceAt(1);
  assert.equal(surface.type, 'STANDARD');
  assert.equal(surface.radius, 40);
  assert.equal(surface.conic, -0.6);
  assert.equal(surface.hasAsphericTerms, false);
});

test('a paraxial surface neither keeps nor gains a shape', () => {
  const paraxial = setSurfaceType(singlet(spherical), 1, 'PARAXIAL');
  assert.ok(paraxial.ok);
  assert.equal(paraxial.value.surfaceAt(1).radius, Infinity);
  assert.equal(paraxial.value.surfaceAt(1).conic, 0);

  // And coming back leaves a plain plane rather than reviving the old radius.
  const back = setSurfaceType(paraxial.value, 1, 'EVEN_ASPHERE');
  assert.ok(back.ok);
  assert.equal(back.value.surfaceAt(1).radius, Infinity);
  assert.equal(back.value.surfaceAt(1).conic, 0);
});

test('an edit the model refuses leaves the design alone and says why', () => {
  const system = singlet(spherical);
  const refused = updateSurface(system, 1, { asphericCoefficients: [1e-5] });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /EVEN_ASPHERE/);

  const accepted = updateSurface(system, 1, { conic: -2 });
  assert.ok(accepted.ok);
  assert.equal(accepted.value.surfaceAt(1).conic, -2);
  // The original is untouched: every edit returns a new system.
  assert.equal(system.surfaceAt(1).conic, -0.6);
});

test('making a surface a mirror moves its medium and its thickness together', () => {
  const system = singlet(spherical); // surface 1 is glass, 5 mm to surface 2
  const result = setMirror(system, 1, true);
  assert.ok(result.ok);

  const mirror = result.value.surfaceAt(1);
  assert.equal(mirror.reflective, true);
  // The medium is the one before it — air here — because light comes back out
  // the way it went in. The model refuses any other answer.
  assert.equal(mirror.material.name, 'AIR');
  // And the thickness flips: +Z is behind the light now, so a positive distance
  // would put surface 2 where nothing reaches it.
  assert.equal(mirror.thickness, -5);
  assert.equal(result.value.vertexZAt(2), -5);

  // Exactly reversible.
  const back = setMirror(result.value, 1, false);
  assert.ok(back.ok);
  assert.equal(back.value.surfaceAt(1).reflective, false);
  assert.equal(back.value.surfaceAt(1).thickness, 5);
});

test('a mirror inside glass adopts the glass, not air', () => {
  const system = singlet(spherical);
  // Surface 2 sits behind the crown, so the light arriving at it is in glass.
  const result = setMirror(system, 2, true);
  assert.ok(result.ok);
  assert.equal(result.value.surfaceAt(2).material.name, N_BK7.name);
});

test('the ends of the system and an ideal lens cannot be mirrors', () => {
  const system = singlet(spherical);
  assert.equal(setMirror(system, 0, true).ok, false);
  assert.equal(setMirror(system, 3, true).ok, false);

  const paraxial = setSurfaceType(system, 1, 'PARAXIAL');
  assert.ok(paraxial.ok);
  const refused = setMirror(paraxial.value, 1, true);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /ideal lens/);
});

test('renaming the lens sets the NAME the file is written with', () => {
  const renamed = renameSystem(singlet(spherical), 'Cooke triplet');
  assert.ok(renamed.ok, renamed.ok ? '' : renamed.error);
  assert.equal(renamed.value.name, 'Cooke triplet');
});

test('a lens name is normalized to what will survive a save', () => {
  // The NAME record is whitespace-delimited: it is read back by splitting on
  // runs of whitespace and re-joining with single spaces, and a newline would
  // end the record outright. So the name is collapsed on the way in rather than
  // stored as something a save would silently change.
  const renamed = renameSystem(singlet(spherical), '  Double\n\tGauss   28°  ');
  assert.ok(renamed.ok, renamed.ok ? '' : renamed.error);
  assert.equal(renamed.value.name, 'Double Gauss 28°');
});

test('a lens cannot be renamed to nothing', () => {
  for (const blank of ['', '   ', '\n\t']) {
    const renamed = renameSystem(singlet(spherical), blank);
    assert.equal(renamed.ok, false, JSON.stringify(blank));
    assert.match(renamed.ok ? '' : renamed.error, /NAME record/);
  }
});

test('renaming touches the name and nothing else', () => {
  const before = singlet(spherical);
  const after = renameSystem(before, 'Renamed');
  assert.ok(after.ok);
  assert.deepStrictEqual(
    after.value.surfaces.map((surface) => surface.id),
    before.surfaces.map((surface) => surface.id),
  );
  assert.deepStrictEqual(after.value.aperture, before.aperture);
  assert.deepStrictEqual([...after.value.fields], [...before.fields]);
  assert.equal(before.name, 'singlet'); // the original is untouched
});

test('a surface can be inserted above a row and below it', () => {
  const system = singlet(spherical);

  const above = insertSurfaceBefore(system, 2);
  assert.ok(above.ok);
  assert.equal(above.value.surfaces.length, 5);
  // The new plane lands *at* the index it was inserted before, pushing that
  // surface down; nothing else about the design moves.
  assert.equal(above.value.surfaceAt(2).radius, Infinity);
  assert.equal(above.value.surfaceAt(3).radius, -60);
  assert.equal(above.value.surfaceAt(1).radius, 40);

  const below = insertSurfaceAfter(system, 1);
  assert.ok(below.ok);
  assert.equal(below.value.surfaceAt(2).radius, Infinity);
  assert.equal(below.value.surfaceAt(3).radius, -60);
});

test('inserting above surface 1 and below surface 0 are the same insert', () => {
  const system = singlet(spherical);
  const above = insertSurfaceBefore(system, 1);
  const below = insertSurfaceAfter(system, 0);
  assert.ok(above.ok);
  assert.ok(below.ok);
  // Only the ids differ — each insert makes its own surface.
  assert.deepEqual(
    above.value.surfaces.map((surface) => [surface.type, surface.radius, surface.thickness]),
    below.value.surfaces.map((surface) => [surface.type, surface.radius, surface.thickness]),
  );
});

test('nothing goes above the object plane or below the image plane', () => {
  const system = singlet(spherical);

  const aboveObject = insertSurfaceBefore(system, 0);
  assert.equal(aboveObject.ok, false);
  assert.match(aboveObject.ok ? '' : aboveObject.error, /object/i);

  const belowImage = insertSurfaceAfter(system, system.surfaces.length - 1);
  assert.equal(belowImage.ok, false);
  assert.match(belowImage.ok ? '' : belowImage.error, /image/i);

  // Refused, not merely rejected by the model afterwards: the design is untouched.
  assert.equal(system.surfaces.length, 4);
});

test('an inserted surface is a plane in air, so it bends no ray', () => {
  const result = insertSurfaceBefore(singlet(spherical), 2);
  assert.ok(result.ok);
  const inserted = result.value.surfaceAt(2);
  assert.equal(inserted.type, 'STANDARD');
  assert.equal(inserted.radius, Infinity);
  assert.equal(inserted.conic, 0);
  assert.equal(inserted.material.name, AIR.name);
  // Sized like the surface it went under rather than left unapertured.
  assert.equal(inserted.semiDiameter, 8);
});
