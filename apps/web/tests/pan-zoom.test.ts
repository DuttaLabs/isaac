import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPan } from '../src/lib/pan-zoom.ts';

const fitted = { width: 900, height: 600 };

test('a view over the drawing is left exactly where it is', () => {
  const view = { x: 100, y: 80, width: 300, height: 200 };
  assert.deepEqual(clampPan(view, fitted), view);
  // The fitted view itself, which is the common case, must not be nudged.
  const whole = { x: 0, y: 0, width: 900, height: 600 };
  assert.deepEqual(clampPan(whole, fitted), whole);
});

test('a view dragged off the drawing is brought back to its edge', () => {
  // Panned far above the drawing: the centre is pulled back to the top edge.
  const escaped = { x: 100, y: -5000, width: 300, height: 200 };
  const fixed = clampPan(escaped, fitted);
  assert.equal(fixed.y + fixed.height / 2, 0);
  assert.equal(fixed.x, 100, 'the axis that was fine is untouched');
  assert.equal(fixed.width, 300);
  assert.equal(fixed.height, 200);

  // And past the far corner, both axes come back.
  const far = clampPan({ x: 9000, y: 9000, width: 300, height: 200 }, fitted);
  assert.equal(far.x + far.width / 2, 900);
  assert.equal(far.y + far.height / 2, 600);
});

test('the clamp still allows every part of the drawing to be reached', () => {
  // Wound in, the view is small: its centre may sit anywhere on the drawing,
  // corners included, which is what panning a map is for.
  const small = { x: 0, y: 0, width: 60, height: 40 };
  for (const [cx, cy] of [
    [0, 0],
    [900, 0],
    [0, 600],
    [900, 600],
    [450, 300],
  ]) {
    const wanted = { ...small, x: cx! - 30, y: cy! - 20 };
    assert.deepEqual(clampPan(wanted, fitted), wanted, `centre (${cx}, ${cy}) is reachable`);
  }
});

test('wound out, the drawing can be pushed to the edge but not out of view', () => {
  // A view larger than the drawing: its centre is still held inside, so the
  // drawing stays on screen however hard it is dragged.
  const wide = { x: 0, y: 0, width: 3000, height: 2000 };
  const pushed = clampPan({ ...wide, x: -9000, y: -9000 }, fitted);
  assert.equal(pushed.x + pushed.width / 2, 0);
  assert.equal(pushed.y + pushed.height / 2, 0);
  // Which means the drawing's own box still overlaps the view.
  assert.ok(pushed.x < fitted.width && pushed.x + pushed.width > 0);
  assert.ok(pushed.y < fitted.height && pushed.y + pushed.height > 0);
});
