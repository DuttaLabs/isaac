import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fitDistance,
  fitZoom,
  placeCamera,
  type CameraFit,
  type SystemExtent,
} from '../src/lib/camera-fit.ts';

/** A doublet's shape: 30 mm across, 107 mm long. Long and thin, as lenses are. */
const DOUBLET: SystemExtent = {
  target: [0, 0, 52.7],
  halfHeight: 15,
  halfLength: 53.7,
  radius: 57.7,
};

const PERSPECTIVE: CameraFit = { projection: 'perspective', fieldOfView: 24, fitMargin: 1.12 };

test('a narrower canvas pushes the camera back', () => {
  const wide = fitDistance(DOUBLET, 24, 5, 1.12);
  const narrow = fitDistance(DOUBLET, 24, 2, 1.12);
  assert.ok(
    narrow > wide,
    `a 2:1 panel should stand further off than a 5:1 one, got ${narrow} vs ${wide}`,
  );
});

test('the binding axis is whichever fills the frame first', () => {
  // Long and thin on a squarish canvas: the length decides.
  const byLength = fitDistance(DOUBLET, 24, 1, 1);
  assert.equal(byLength, DOUBLET.halfLength / Math.tan((24 * Math.PI) / 360));

  // Short and fat on a wide canvas: the height decides.
  const disc: SystemExtent = { ...DOUBLET, halfHeight: 40, halfLength: 5 };
  const byHeight = fitDistance(disc, 24, 4, 1);
  assert.equal(byHeight, disc.halfHeight / Math.tan((24 * Math.PI) / 360));
});

test('halving the field of view roughly doubles the distance', () => {
  // The dolly-zoom relation the field-of-view knob rests on: apparent size goes
  // as distance * tan(fov / 2), so holding size fixed while narrowing the angle
  // means standing further off — which is what flattens the perspective.
  const near = fitDistance(DOUBLET, 24, 3, 1.12);
  const far = fitDistance(DOUBLET, 12, 3, 1.12);
  const ratio = far / near;
  const expected = Math.tan((24 * Math.PI) / 360) / Math.tan((12 * Math.PI) / 360);
  assert.ok(Math.abs(ratio - expected) < 1e-9, `expected ${expected}, got ${ratio}`);
  // A shade over double, not exactly: tan grows faster than its argument, so
  // the far half of the angle is worth more distance than the near half.
  assert.ok(ratio > 2 && ratio < 2.05, `halving 24° should about double the distance: ${ratio}`);
});

test('the fit margin scales the distance in proportion', () => {
  const tight = fitDistance(DOUBLET, 24, 3, 1);
  const loose = fitDistance(DOUBLET, 24, 3, 1.5);
  assert.ok(Math.abs(loose / tight - 1.5) < 1e-12);
});

test('orthographic zoom fills the tighter axis', () => {
  // 1000 x 200 px: 53.7 mm of length into 500 px, 15 mm of height into 100 px.
  // The height is the tighter of the two, so it sets the zoom.
  const zoom = fitZoom(DOUBLET, 1000, 200, 1);
  assert.equal(zoom, 100 / 15);
  assert.ok(zoom < 500 / 53.7);
});

test('orthographic zoom scales with the canvas', () => {
  const small = fitZoom(DOUBLET, 500, 100, 1.12);
  const big = fitZoom(DOUBLET, 1000, 200, 1.12);
  assert.ok(Math.abs(big / small - 2) < 1e-12);
});

test('the camera sits along the given direction, at the fitted distance', () => {
  const direction = [0, 0, -1] as const;
  const placed = placeCamera(DOUBLET, PERSPECTIVE, direction, 1000, 200);
  const distance = fitDistance(DOUBLET, 24, 5, 1.12);
  assert.deepEqual(placed.position, [0, 0, DOUBLET.target[2] - distance]);
  assert.equal(placed.zoom, 1);
});

test('the depth range brackets the system from where the camera stands', () => {
  const placed = placeCamera(DOUBLET, PERSPECTIVE, [0, 0, -1], 1000, 200);
  const distance = fitDistance(DOUBLET, 24, 5, 1.12);
  assert.ok(placed.near > 0, 'near must be positive or nothing draws');
  assert.ok(placed.near < distance - DOUBLET.radius, 'the near face must be inside the range');
  assert.ok(placed.far > distance + DOUBLET.radius, 'the far face must be inside the range');
});

test('an orthographic fit ignores the field of view and answers with zoom', () => {
  const wide = placeCamera(
    DOUBLET,
    { projection: 'orthographic', fieldOfView: 60, fitMargin: 1.12 },
    [0, 0, -1],
    1000,
    200,
  );
  const narrow = placeCamera(
    DOUBLET,
    { projection: 'orthographic', fieldOfView: 6, fitMargin: 1.12 },
    [0, 0, -1],
    1000,
    200,
  );
  assert.deepEqual(wide, narrow);
  assert.equal(wide.zoom, fitZoom(DOUBLET, 1000, 200, 1.12));
});

test('a system with no length still gets a finite fit', () => {
  // A single plane: no extent along the axis at all. The height carries it, and
  // the zoom guard keeps the orthographic answer off infinity.
  const flat: SystemExtent = { target: [0, 0, 0], halfHeight: 10, halfLength: 0, radius: 10 };
  const perspective = placeCamera(flat, PERSPECTIVE, [0, 0, -1], 1000, 200);
  assert.ok(Number.isFinite(perspective.position[2]));
  const ortho = placeCamera(
    flat,
    { projection: 'orthographic', fieldOfView: 24, fitMargin: 1.12 },
    [0, 0, -1],
    1000,
    200,
  );
  assert.ok(Number.isFinite(ortho.zoom) && ortho.zoom > 0);
});
