import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeFirstOrder,
  computeLayoutTraces,
  computeVolumeTraces,
} from '../src/lib/analysis.ts';
import { emptySystem } from '../src/lib/default-system.ts';
import { buildLayout } from '../src/lib/layout.ts';
import { VIEW_PLANES, VIEW_PLANE_IDS } from '../src/lib/view-plane.ts';

test('a new system arrives with the first surface already in it', () => {
  const system = emptySystem();

  assert.equal(system.surfaces.length, 3);
  assert.equal(system.objectSurface.type, 'OBJECT');
  assert.equal(system.imageSurface.type, 'IMAGE');

  // The two steps every new design would otherwise begin with.
  assert.equal(system.stopIndex, 1);
  const first = system.surfaces[1]!;
  assert.equal(first.type, 'STANDARD');
  assert.equal(first.radius, Infinity);
});

test('a blank page still says what it is made of', () => {
  const system = emptySystem();

  // A fixed pupil rather than a float, so editing the stop's semi-diameter on a
  // half-built system does not silently resize the beam.
  assert.equal(system.aperture?.type, 'ENTRANCE_PUPIL_DIAMETER');
  assert.ok((system.aperture?.value ?? 0) > 0);
  assert.equal(system.fields.length, 1);
  assert.ok(system.wavelengthsNm.length > 0);
  assert.ok(system.primaryWavelengthIndex < system.wavelengthsNm.length);
});

test('first order opens on an honest afocal summary, not an error', () => {
  const system = emptySystem();
  const firstOrder = computeFirstOrder(system);
  assert.ok(firstOrder.ok, firstOrder.ok ? '' : firstOrder.error);

  // A plane in air bends nothing: no power, no focus, nothing to report wrongly.
  assert.equal(firstOrder.value.properties.power, 0);
  assert.equal(firstOrder.value.properties.effectiveFocalLength, Infinity);

  // Nothing in front of the stop, so the entrance pupil is the stop itself —
  // at z = 0, and the size the aperture asks for.
  assert.ok(firstOrder.value.entrance, 'the new system has a stop, so it has an entrance pupil');
  assert.equal(firstOrder.value.entrance.z, 0);
  assert.equal(firstOrder.value.entrancePupilRadius, (system.aperture?.value ?? 0) / 2);
});

test('every layout plane draws the new system', () => {
  const system = emptySystem();

  for (const planeId of VIEW_PLANE_IDS) {
    const plane = VIEW_PLANES[planeId];
    // The same choice the app makes: a fan spread along the plane being drawn,
    // and a pupil grid end-on, where no fan reads as anything but a dot.
    const traces =
      plane.fanAxis === undefined
        ? computeVolumeTraces(system, { gridCount: 5, wavelengthIndices: [0], fieldIndices: [0] })
        : computeLayoutTraces(system, {
            raysPerFan: 5,
            fanAxis: plane.fanAxis,
            wavelengthIndices: [0],
            fieldIndices: [0],
          });
    assert.ok(traces.ok, `${planeId}: ${traces.ok ? '' : traces.error}`);

    const geometry = buildLayout(system, traces.value, 10, plane);
    // The stop and the image; the object is at infinity and has no extent.
    assert.equal(geometry.profiles.length, 2);
    // A plane in air is not an element, so there is no glass to draw.
    assert.equal(geometry.bodies.length, 0);
    assert.ok(geometry.rayPaths.length > 0, `${planeId} traced no rays`);
    for (const bound of [
      geometry.bounds.minH,
      geometry.bounds.maxH,
      geometry.bounds.minV,
      geometry.bounds.maxV,
    ]) {
      assert.ok(Number.isFinite(bound), `${planeId} bounds are not finite`);
    }
  }
});

test('the beam fills the stop without a ray being vignetted by it', () => {
  const system = emptySystem();
  const traces = computeLayoutTraces(system, {
    raysPerFan: 5,
    fanAxis: 'y',
    wavelengthIndices: [0],
    fieldIndices: [0],
  });
  assert.ok(traces.ok, traces.ok ? '' : traces.error);

  const stop = system.surfaces[system.stopIndex!]!;
  for (const trace of traces.value) {
    // The rim ray lands exactly on the rim, which is the aperture said twice —
    // a pupil half a hair larger would start the blank page half vignetted.
    assert.equal(trace.result.status, 'TERMINATED');
    // A plane in air bends nothing, so the direction is the one it started with.
    assert.ok(Math.abs(trace.result.finalRay.direction.z - 1) < 1e-12);
  }

  const heights = traces.value.map((trace) => trace.result.intersections[0]!.point.y);
  assert.ok(Math.abs(Math.max(...heights) - stop.semiDiameter) < 1e-9);
  assert.ok(Math.abs(Math.min(...heights) + stop.semiDiameter) < 1e-9);
});
