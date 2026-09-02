import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fitDistance,
  fitZoom,
  placeCamera,
  projectedHalfExtents,
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

/**
 * Straight at the side of the system: the one view where its length lies exactly
 * across the frame and its diameter exactly up it. Every assertion written
 * before the fit knew which way the camera faced was written for this view, so
 * naming it here keeps them saying what they always meant.
 */
const SIDE = [-1, 0, 0] as const;

/** Down the axis from in front. The length is edge-on, so it costs no width. */
const HEAD_ON = [0, 0, -1] as const;

/** What the panel actually uses: off to one side and about 25 degrees up. */
const HOME = [-0.86, 0.42, -0.28] as const;

const PERSPECTIVE: CameraFit = {
  projection: 'perspective',
  fieldOfView: 24,
  fitMargin: 1.12,
  cameraDistance: 1,
};

test('a narrower canvas pushes the camera back', () => {
  const wide = fitDistance(DOUBLET, 24, 5, 1.12, SIDE);
  const narrow = fitDistance(DOUBLET, 24, 2, 1.12, SIDE);
  assert.ok(
    narrow > wide,
    `a 2:1 panel should stand further off than a 5:1 one, got ${narrow} vs ${wide}`,
  );
});

test('the binding axis is whichever fills the frame first', () => {
  // Long and thin on a squarish canvas: the length decides.
  const byLength = fitDistance(DOUBLET, 24, 1, 1, SIDE);
  assert.equal(byLength, DOUBLET.halfLength / Math.tan((24 * Math.PI) / 360));

  // Short and fat on a wide canvas: the height decides.
  const disc: SystemExtent = { ...DOUBLET, halfHeight: 40, halfLength: 5 };
  const byHeight = fitDistance(disc, 24, 4, 1, SIDE);
  assert.equal(byHeight, disc.halfHeight / Math.tan((24 * Math.PI) / 360));
});

test('halving the field of view roughly doubles the distance', () => {
  // The dolly-zoom relation the field-of-view knob rests on: apparent size goes
  // as distance * tan(fov / 2), so holding size fixed while narrowing the angle
  // means standing further off — which is what flattens the perspective.
  const near = fitDistance(DOUBLET, 24, 3, 1.12, SIDE);
  const far = fitDistance(DOUBLET, 12, 3, 1.12, SIDE);
  const ratio = far / near;
  const expected = Math.tan((24 * Math.PI) / 360) / Math.tan((12 * Math.PI) / 360);
  assert.ok(Math.abs(ratio - expected) < 1e-9, `expected ${expected}, got ${ratio}`);
  // A shade over double, not exactly: tan grows faster than its argument, so
  // the far half of the angle is worth more distance than the near half.
  assert.ok(ratio > 2 && ratio < 2.05, `halving 24° should about double the distance: ${ratio}`);
});

test('the fit margin scales the distance in proportion', () => {
  const tight = fitDistance(DOUBLET, 24, 3, 1, SIDE);
  const loose = fitDistance(DOUBLET, 24, 3, 1.5, SIDE);
  assert.ok(Math.abs(loose / tight - 1.5) < 1e-12);
});

test('orthographic zoom fills the tighter axis', () => {
  // 1000 x 200 px: 53.7 mm of length into 500 px, 15 mm of height into 100 px.
  // The height is the tighter of the two, so it sets the zoom.
  const zoom = fitZoom(DOUBLET, 1000, 200, 1, SIDE);
  assert.equal(zoom, 100 / 15);
  assert.ok(zoom < 500 / 53.7);
});

test('orthographic zoom scales with the canvas', () => {
  const small = fitZoom(DOUBLET, 500, 100, 1.12, SIDE);
  const big = fitZoom(DOUBLET, 1000, 200, 1.12, SIDE);
  assert.ok(Math.abs(big / small - 2) < 1e-12);
});

test('the camera sits along the given direction, at the fitted distance', () => {
  const direction = [0, 0, -1] as const;
  const placed = placeCamera(DOUBLET, PERSPECTIVE, direction, 1000, 200);
  const distance = fitDistance(DOUBLET, 24, 5, 1.12, HEAD_ON);
  assert.deepEqual(placed.position, [0, 0, DOUBLET.target[2] - distance]);
  assert.equal(placed.zoom, 1);
});

test('the depth range brackets the system from where the camera stands', () => {
  const placed = placeCamera(DOUBLET, PERSPECTIVE, [0, 0, -1], 1000, 200);
  const distance = fitDistance(DOUBLET, 24, 5, 1.12, HEAD_ON);
  assert.ok(placed.near > 0, 'near must be positive or nothing draws');
  assert.ok(placed.near < distance - DOUBLET.radius, 'the near face must be inside the range');
  assert.ok(placed.far > distance + DOUBLET.radius, 'the far face must be inside the range');
});

test('an orthographic fit ignores the field of view and answers with zoom', () => {
  const wide = placeCamera(
    DOUBLET,
    { projection: 'orthographic', fieldOfView: 60, fitMargin: 1.12, cameraDistance: 1 },
    [0, 0, -1],
    1000,
    200,
  );
  const narrow = placeCamera(
    DOUBLET,
    { projection: 'orthographic', fieldOfView: 6, fitMargin: 1.12, cameraDistance: 1 },
    [0, 0, -1],
    1000,
    200,
  );
  assert.deepEqual(wide, narrow);
  assert.equal(wide.zoom, fitZoom(DOUBLET, 1000, 200, 1.12, HEAD_ON));
});

test('a system with no length still gets a finite fit', () => {
  // A single plane: no extent along the axis at all. The height carries it, and
  // the zoom guard keeps the orthographic answer off infinity.
  const flat: SystemExtent = { target: [0, 0, 0], halfHeight: 10, halfLength: 0, radius: 10 };
  const perspective = placeCamera(flat, PERSPECTIVE, [0, 0, -1], 1000, 200);
  assert.ok(Number.isFinite(perspective.position[2]));
  const ortho = placeCamera(
    flat,
    { projection: 'orthographic', fieldOfView: 24, fitMargin: 1.12, cameraDistance: 1 },
    [0, 0, -1],
    1000,
    200,
  );
  assert.ok(Number.isFinite(ortho.zoom) && ortho.zoom > 0);
});

test('camera distance multiplies the fitted standoff', () => {
  const fitted = placeCamera(DOUBLET, PERSPECTIVE, [0, 0, -1], 1000, 200);
  const back = placeCamera(DOUBLET, { ...PERSPECTIVE, cameraDistance: 2 }, [0, 0, -1], 1000, 200);
  const fittedOffset = DOUBLET.target[2] - fitted.position[2];
  const backOffset = DOUBLET.target[2] - back.position[2];
  assert.ok(Math.abs(backOffset / fittedOffset - 2) < 1e-12);
});

test('the depth range follows the camera back', () => {
  // Stepping back and leaving `far` where it was would clip the system away.
  const back = placeCamera(DOUBLET, { ...PERSPECTIVE, cameraDistance: 3 }, [0, 0, -1], 1000, 200);
  const distance = fitDistance(DOUBLET, 24, 5, 1.12, HEAD_ON) * 3;
  assert.ok(back.far > distance + DOUBLET.radius);
  assert.ok(back.near < distance - DOUBLET.radius);
});

test('camera distance changes nothing you can see orthographically', () => {
  // Size there is zoom, so the standoff only moves the clipping planes.
  const ortho: CameraFit = {
    projection: 'orthographic',
    fieldOfView: 24,
    fitMargin: 1.12,
    cameraDistance: 1,
  };
  const near = placeCamera(DOUBLET, ortho, [0, 0, -1], 1000, 200);
  const far = placeCamera(DOUBLET, { ...ortho, cameraDistance: 3 }, [0, 0, -1], 1000, 200);
  assert.equal(near.zoom, far.zoom);
  assert.ok(far.position[2] < near.position[2], 'it does still move the camera');
  assert.ok(far.far > near.far, 'and the depth range with it');
});

test('distance and fit margin are the same lever in perspective', () => {
  // Both scale the standoff, which is why the panel offers them as two knobs
  // rather than one: a margin is how the fit frames, distance is where you then
  // stand. Anything relying on them being independent is relying on nothing.
  const byMargin = placeCamera(DOUBLET, { ...PERSPECTIVE, fitMargin: 2.24 }, [0, 0, -1], 1000, 200);
  const byDistance = placeCamera(
    DOUBLET,
    { ...PERSPECTIVE, cameraDistance: 2 },
    [0, 0, -1],
    1000,
    200,
  );
  assert.ok(Math.abs(byMargin.position[2] - byDistance.position[2]) < 1e-9);
});

test('a side-on view sees the length across the frame and the diameter up it', () => {
  // The case the old rule assumed, and the one it got right.
  const seen = projectedHalfExtents(DOUBLET, SIDE);
  assert.ok(Math.abs(seen.horizontal - DOUBLET.halfLength) < 1e-9);
  assert.ok(Math.abs(seen.vertical - DOUBLET.halfHeight) < 1e-9);
});

test('head on, the length is edge-on and costs nothing in either direction', () => {
  // Looking down the axis, a long lens and a short one fill the same square.
  const seen = projectedHalfExtents(DOUBLET, HEAD_ON);
  assert.ok(Math.abs(seen.horizontal - DOUBLET.halfHeight) < 1e-9);
  assert.ok(Math.abs(seen.vertical - DOUBLET.halfHeight) < 1e-9);
});

test('an elevated view sees far more height than the system has', () => {
  // The bug this replaced: from 25 degrees up, a 107 mm doublet throws a
  // vertical shadow well over its own 30 mm diameter, and the old rule counted
  // only the diameter.
  const seen = projectedHalfExtents(DOUBLET, HOME);
  assert.ok(
    seen.vertical > 1.5 * DOUBLET.halfHeight,
    `the home view should see well over the bare half-height, got ${seen.vertical}`,
  );
  // Never more than the box can possibly subtend, whatever the angle.
  const bound = 2 * DOUBLET.halfHeight + DOUBLET.halfLength;
  assert.ok(seen.vertical <= bound + 1e-9);
});

test('a wide short panel no longer frames the system too large', () => {
  // 1489 x 233 -- the second window's Layout 3D panel, aspect 6.4. The
  // horizontal term collapses there, so the vertical one binds, and under the
  // old rule that was the under-counted one: the model came out centered and
  // clipped top and bottom.
  const aspect = 1489 / 233;
  const now = fitDistance(DOUBLET, 24, aspect, 1.24, HOME);
  const verticalTan = Math.tan((24 * Math.PI) / 360);
  const before =
    Math.max(DOUBLET.halfHeight / verticalTan, DOUBLET.halfLength / (verticalTan * aspect)) * 1.24;
  assert.ok(now > before, `should stand further back than the old rule: ${now} vs ${before}`);

  // And it must actually fit: the projected height inside the frustum's own
  // half-height at that distance, with the margin still to spare.
  const seen = projectedHalfExtents(DOUBLET, HOME);
  assert.ok(now * verticalTan >= seen.vertical, 'the system must fit up the frame');
  assert.ok(now * verticalTan * aspect >= seen.horizontal, 'and across it');
});

test('a tall panel is barely affected, so the main window does not move much', () => {
  // The horizontal term binds on an ordinary panel, and that one was nearly
  // right already -- this fix must not quietly rescale every existing view.
  const aspect = 16 / 9;
  const now = fitDistance(DOUBLET, 24, aspect, 1.24, HOME);
  const verticalTan = Math.tan((24 * Math.PI) / 360);
  const before =
    Math.max(DOUBLET.halfHeight / verticalTan, DOUBLET.halfLength / (verticalTan * aspect)) * 1.24;
  assert.ok(now / before < 1.15, `should be a small correction, got ${now / before}`);
});

test('looking straight down still has a defined right-hand direction', () => {
  // Up is +Y, so a camera directly overhead leaves `right` undefined; the fit
  // may be asked for any direction even though the orbit clamps away from this.
  const seen = projectedHalfExtents(DOUBLET, [0, 1, 0]);
  assert.ok(Number.isFinite(seen.horizontal) && seen.horizontal > 0);
  assert.ok(Number.isFinite(seen.vertical) && seen.vertical > 0);
});
