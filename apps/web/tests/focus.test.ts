import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, N_BK7, OpticalSystem, Surface, paraxialProperties } from '@isaac/optical-core';
import { computeSpot } from '../src/lib/analysis.ts';
import { quickFocus, spotMerit } from '../src/lib/focus.ts';

/**
 * A biconvex singlet with the image plane wherever we put it. Fast enough to
 * focus many times over, and aberrated enough that best focus is somewhere the
 * paraxial solve would not put it.
 */
function singlet(imageDistance: number, imageSemiDiameter = Infinity): OpticalSystem {
  return new OpticalSystem({
    name: 'singlet',
    wavelengthsNm: [486.13, 587.56, 656.27],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    fields: [{ angleDeg: 0 }, { angleDeg: 3 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 6,
        semiDiameter: 10,
        material: N_BK7,
        isStop: true,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: -50,
        thickness: imageDistance,
        semiDiameter: 10,
        material: AIR,
      }),
      new Surface({
        id: 'img',
        type: 'IMAGE',
        thickness: 0,
        semiDiameter: imageSemiDiameter,
        material: AIR,
      }),
    ],
  });
}

/**
 * The naive merit the real one must not be: RMS over the rays that arrived,
 * ignoring however many were lost getting there.
 */
function survivorsOnly(system: OpticalSystem): number {
  let sumSquares = 0;
  let traced = 0;
  for (let fieldIndex = 0; fieldIndex < system.fields.length; fieldIndex += 1) {
    const spot = computeSpot(system, fieldIndex, 9);
    assert.ok(spot.ok, spot.ok ? '' : spot.error);
    sumSquares += spot.value.rmsRadius * spot.value.rmsRadius * spot.value.traced;
    traced += spot.value.traced;
  }
  return traced > 0 ? Math.sqrt(sumSquares / traced) : Infinity;
}

function focusedThickness(system: OpticalSystem): number {
  const result = quickFocus(system);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value.thickness;
}

test('focusing lands on a genuine minimum of the merit', () => {
  const result = quickFocus(singlet(60));
  assert.ok(result.ok, result.ok ? '' : result.error);
  const { thickness, rms, previousRms } = result.value;

  assert.ok(rms < previousRms, 'the spot must get smaller');

  // The real check: step either way and the merit must get worse. This is what
  // makes it a minimum rather than merely somewhere the search stopped.
  for (const step of [-0.5, -0.1, 0.1, 0.5]) {
    const nearby = spotMerit(singlet(thickness + step));
    assert.ok(nearby > rms, `merit at ${step} away (${nearby}) should exceed ${rms}`);
  }
});

test('the same focus is found from anywhere, near or far', () => {
  // A search that only followed the local slope would stall on the plateau far
  // from focus, where every ray misses by about as much whichever way it goes.
  const found = [45, 60, 30, 100, 5].map((start) => focusedThickness(singlet(start)));
  const first = found[0]!;
  for (const thickness of found) {
    assert.ok(
      Math.abs(thickness - first) < 1e-3,
      `starts disagree: ${found.map((value) => value.toFixed(4)).join(', ')}`,
    );
  }
  // Near the back focal distance, without being pinned to an exact number.
  const { backFocalDistance } = paraxialProperties(singlet(45));
  assert.ok(
    Math.abs(first - backFocalDistance) < 0.2 * backFocalDistance,
    `${first} is nowhere near the back focal distance ${backFocalDistance}`,
  );
});

test('best focus is not the paraxial focus, and beats it', () => {
  // Spherical aberration pulls the tightest spot inside the paraxial focus. If
  // these two ever coincide, the merit has stopped seeing real ray heights.
  const { backFocalDistance } = paraxialProperties(singlet(45));
  const best = focusedThickness(singlet(45));

  assert.ok(best < backFocalDistance, 'best focus should sit inside paraxial focus');
  assert.ok(spotMerit(singlet(best)) < spotMerit(singlet(backFocalDistance)));
});

test('focusing an already focused system moves nothing', () => {
  const once = quickFocus(singlet(60));
  assert.ok(once.ok, once.ok ? '' : once.error);

  const twice = quickFocus(once.value.system);
  assert.ok(twice.ok, twice.ok ? '' : twice.error);
  assert.equal(twice.value.thickness, once.value.thickness, 'a second run must be a no-op');
  assert.equal(
    twice.value.previousThickness,
    twice.value.thickness,
    'nothing to improve means nothing to change',
  );
});

test('only the surface before the image moves', () => {
  const before = singlet(60);
  const result = quickFocus(before);
  assert.ok(result.ok, result.ok ? '' : result.error);
  const after = result.value.system;

  assert.equal(result.value.surfaceIndex, 2);
  assert.equal(after.surfaces.length, before.surfaces.length);
  for (let index = 0; index < before.surfaces.length; index += 1) {
    if (index === result.value.surfaceIndex) {
      continue;
    }
    assert.equal(after.surfaceAt(index).thickness, before.surfaceAt(index).thickness);
    assert.equal(after.surfaceAt(index).radius, before.surfaceAt(index).radius);
    assert.equal(after.surfaceAt(index).material, before.surfaceAt(index).material);
  }
});

test('a focus that blinds a finite detector cannot beat one that fills it', () => {
  const detector = 0.5;
  const best = focusedThickness(singlet(45));

  // The trap, demonstrated: 15 mm out of focus, this detector catches only the
  // three axial chief rays, which sit exactly on axis. Scoring the survivors
  // alone calls that a flawless image — 0 µm against 126 µm at true focus.
  assert.ok(
    survivorsOnly(singlet(60, detector)) < survivorsOnly(singlet(best, detector)),
    'the fixture must actually exhibit the trap, or this test proves nothing',
  );

  // The merit charges each lost ray the detector's radius, so it is not fooled.
  assert.ok(
    spotMerit(singlet(60, detector)) > spotMerit(singlet(best, detector)),
    'losing rays must not score better than catching them',
  );
});

test('a detector-limited system still focuses where the spot is smallest', () => {
  const free = focusedThickness(singlet(60));
  const limited = focusedThickness(singlet(60, 0.5));
  assert.ok(
    Math.abs(limited - free) < 0.5,
    `a detector should not move best focus far: ${limited} against ${free}`,
  );
});

test('a system with nothing between object and image is refused', () => {
  const bare = new OpticalSystem({
    name: 'bare',
    wavelengthsNm: [587.56],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    fields: [{ angleDeg: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: 100, material: AIR }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });

  const result = quickFocus(bare);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /no surface before the image/i);
  }
});
