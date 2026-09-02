import assert from 'node:assert/strict';
import test from 'node:test';
import { OpticalSystem, Surface, type CoordinateTransform } from '@isaac/optical-core';
import { apertureRollDegrees } from '../src/lib/aperture-roll.ts';

function turn(id: string, tiltZDeg: number): Surface {
  const transform: CoordinateTransform = {
    decenterX: 0,
    decenterY: 0,
    tiltXDeg: 0,
    tiltYDeg: 0,
    tiltZDeg,
    tiltFirst: false,
  };
  return new Surface({
    id,
    type: 'COORDINATE_TRANSFORM',
    thickness: 0,
    coordinateTransform: transform,
  });
}

/** The LSST idiom: a z tilt, a baffle, two counter-tilts, an identical baffle. */
function baffles(objectAtInfinity: boolean): OpticalSystem {
  const baffle = (id: string, thickness: number): Surface =>
    new Surface({
      id,
      type: 'STANDARD',
      thickness,
      semiDiameter: 1600,
      aperture: { kind: 'RECTANGULAR_OBSCURATION', halfWidthX: 400, halfWidthY: 1600 },
    });

  return new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: objectAtInfinity ? Infinity : 500 }),
      turn('ct-a', 45),
      baffle('baffle-1', 0),
      turn('ct-b', -45),
      turn('ct-c', -45),
      baffle('baffle-2', 100),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
}

test('the cumulative z tilt reaches the surfaces after it, in degrees', () => {
  const system = baffles(true);
  assert.ok(Math.abs(apertureRollDegrees(system, 2) - 45) < 1e-9);
  assert.ok(Math.abs(apertureRollDegrees(system, 5) + 45) < 1e-9);
  // Nothing before the first transform is turned at all.
  assert.equal(apertureRollDegrees(system, 1), 0);
});

test('an object at infinity has no frame to read a turn from, and is not asked for one', () => {
  // `poseAt(0)` throws there by design. The icon still has a cell to draw, so
  // this has to answer rather than propagate that.
  assert.equal(apertureRollDegrees(baffles(true), 0), 0);
  assert.equal(apertureRollDegrees(baffles(false), 0), 0);
  // And an index off either end answers instead of throwing.
  assert.equal(apertureRollDegrees(baffles(true), -1), 0);
  assert.equal(apertureRollDegrees(baffles(true), 99), 0);
});
