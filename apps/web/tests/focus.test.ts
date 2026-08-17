import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, N_BK7, OpticalSystem, Surface, paraxialProperties } from '@isaac/optical-core';
import { computeSpot } from '../src/lib/analysis.ts';
import { measureSpot, quickFocus, spotMerit } from '../src/lib/focus.ts';

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

/**
 * A singlet with a small aperture partway to the image — the shape of a real
 * design's interior vignetting, which is what the corpus triage turned up. The
 * gate sits far enough from the stop that an off-axis beam walks off it entirely
 * while the axial beam is only clipped.
 */
function gated(gateSemiDiameter: number, angleDeg: number, imageSemiDiameter = 20): OpticalSystem {
  return new OpticalSystem({
    name: 'gated',
    wavelengthsNm: [587.5618],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    fields: [{ angleDeg: 0 }, { angleDeg }],
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
        thickness: 40,
        semiDiameter: 10,
        material: AIR,
      }),
      new Surface({
        id: 'gate',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 12,
        semiDiameter: gateSemiDiameter,
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

test('a ray lost before the image is not charged to the focus', () => {
  const system = gated(0.9, 5);
  const axial = computeSpot(system, 0, 9);
  assert.ok(axial.ok, axial.ok ? '' : axial.error);

  // The case: rays stopped by an interior aperture, none by the image itself.
  assert.ok(axial.value.traced > 0 && axial.value.blocked > 0, 'the gate must clip the axial beam');
  assert.equal(axial.value.blockedAtImage, 0, 'nothing should reach the image and be refused');

  // Charging those rays the image semi-diameter is what the merit used to do,
  // and it buries a 0.9 mm spot under a 20 mm aperture.
  const asIfCharged = Math.sqrt(
    (axial.value.rmsRadius ** 2 * axial.value.traced + axial.value.blocked * 20 ** 2) /
      (axial.value.traced + axial.value.blocked),
  );
  const merit = spotMerit(system);

  assert.ok(
    Math.abs(merit - axial.value.rmsRadius) < 1e-12,
    `the merit should be the spot itself: ${merit} against ${axial.value.rmsRadius}`,
  );
  assert.ok(merit < asIfCharged / 5, `${merit} must be nowhere near the penalised ${asIfCharged}`);
});

test('the image aperture does not move a focus it stops no rays with', () => {
  // Rays lost at the gate are lost at every image distance, so how wide the
  // *image* is cannot matter here — and with the penalty applied to them it did:
  // the merit became mostly a constant, the relative improvement vanished into
  // it, and the search reported "already focused" without moving. Four corpus
  // files sat at exactly 0.000 for this reason.
  //
  // (Note the aperture that must not matter is the image's. The gate itself
  // legitimately moves best focus — clipping the beam changes its spherical
  // aberration — so this compares two image apertures, not two gates.)
  const bounded = quickFocus(gated(0.9, 5, 20));
  const unbounded = quickFocus(gated(0.9, 5, Infinity));
  assert.ok(bounded.ok, bounded.ok ? '' : bounded.error);
  assert.ok(unbounded.ok, unbounded.ok ? '' : unbounded.error);

  assert.ok(
    Math.abs(bounded.value.thickness - unbounded.value.thickness) < 1e-6,
    `the image aperture moved best focus: ${bounded.value.thickness} against ${unbounded.value.thickness}`,
  );
  assert.ok(
    bounded.value.thickness !== bounded.value.previousThickness,
    'and the search must actually have moved, not been masked into a no-op',
  );
});

test('a field with no image is left out rather than fatal', () => {
  const system = gated(0.9, 5);
  const dead = computeSpot(system, 1, 9);
  assert.ok(dead.ok, dead.ok ? '' : dead.error);
  assert.equal(dead.value.traced, 0, 'the off-axis field must be fully vignetted for this test');

  // Before the fix, one dead field made the merit infinite at every thickness
  // and the whole design was refused.
  const measured = measureSpot(system);
  assert.deepEqual(measured.droppedFields, [1]);
  assert.ok(Number.isFinite(measured.rms), 'the field that does image still measures');

  const result = quickFocus(system);
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(result.value.droppedFields, [1], 'and the outcome says which field it skipped');
});

test('a field the engine refuses outright is left out too', () => {
  // 90° is the fisheye case from the corpus: the ray runs parallel to the plane
  // it would launch from, so ray generation throws rather than returning nothing.
  const system = gated(10, 90);
  assert.equal(computeSpot(system, 1, 9).ok, false);

  const result = quickFocus(system);
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(result.value.droppedFields, [1]);
});

test('a design whose spot only grows focuses at the boundary, not nowhere', () => {
  // An ideal diverging lens on a collimated beam: the spot is smallest where the
  // beam is narrowest, which is the lens itself. The minimum is therefore at
  // thickness 0, where the search is clamped, and no window can bracket it. That
  // used to exhaust the widenings and be reported as "no image could be
  // measured" — which was wrong: the image is measurable everywhere.
  const diverging = new OpticalSystem({
    name: 'diverging',
    wavelengthsNm: [587.5618],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    fields: [{ angleDeg: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 'lens',
        type: 'PARAXIAL',
        focalLength: -50,
        thickness: 25,
        semiDiameter: 20,
        material: AIR,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });

  const result = quickFocus(diverging);
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.equal(result.value.thickness, 0, 'the answer is the boundary');
  assert.ok(result.value.rms < result.value.previousRms, 'and it is an improvement on 25 mm out');
});

test('a system where no field images at all is still refused', () => {
  // Every field off axis, and an aperture that passes nothing: there is no focus
  // to find, and saying so is right.
  const blind = gated(1e-9, 8).with({ fields: [{ angleDeg: 5 }, { angleDeg: 8 }] });
  assert.equal(spotMerit(blind), Infinity);

  const result = quickFocus(blind);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /no field has a ray that reaches the image plane/i);
  }
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
