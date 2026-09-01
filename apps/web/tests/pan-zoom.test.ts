import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPan } from '../src/lib/pan-zoom.ts';

const fitted = { width: 900, height: 600 };
/** Mirrors the rule: half the shorter of view and drawing stays within the other. */
const keptOf = (extent: number, limit: number) => Math.min(extent, limit) / 2;

/** How much of `[0, limit]` the view `[start, start + extent]` still covers. */
function overlap(start: number, extent: number, limit: number): number {
  return Math.max(0, Math.min(start + extent, limit) - Math.max(start, 0));
}

test('a view over the drawing is left exactly where it is', () => {
  const view = { x: 100, y: 80, width: 300, height: 200 };
  assert.deepEqual(clampPan(view, fitted), view);
  // The fitted view itself, which is the common case, must not be nudged.
  const whole = { x: 0, y: 0, width: 900, height: 600 };
  assert.deepEqual(clampPan(whole, fitted), whole);
});

test('a view dragged off the drawing keeps part of it in sight', () => {
  const escaped = clampPan({ x: 100, y: -5000, width: 300, height: 200 }, fitted);
  assert.equal(overlap(escaped.y, escaped.height, fitted.height), keptOf(200, fitted.height));
  assert.equal(escaped.x, 100, 'the axis that was fine is untouched');
  assert.equal(escaped.width, 300);
  assert.equal(escaped.height, 200);

  const far = clampPan({ x: 9000, y: 9000, width: 300, height: 200 }, fitted);
  assert.equal(overlap(far.x, far.width, fitted.width), keptOf(300, fitted.width));
  assert.equal(overlap(far.y, far.height, fitted.height), keptOf(200, fitted.height));
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

/**
 * The property the old rule got wrong, and the reason this one exists.
 *
 * That rule held the view's *centre* inside the fitted box — a limit stated in
 * drawing units, so the room it left on **screen** shrank in step with the
 * drawing. Wound out eight times the panel was eight times the drawing and the
 * drawing could be moved across an eighth of it: a big panel the object could
 * only occupy a corner of, for no reason anything on screen could explain.
 *
 * Screen travel is `pannable units / view.width` of the panel's width, so the
 * test is that this fraction does not collapse as the view grows.
 */
test('the room to move does not shrink as the view is wound out', () => {
  const travelInPanels = (extent: number): number => {
    const leftMost = clampPan({ x: -1e6, y: 0, width: extent, height: extent }, fitted).x;
    const rightMost = clampPan({ x: 1e6, y: 0, width: extent, height: extent }, fitted).x;
    return (rightMost - leftMost) / extent;
  };

  // Fitted, and then wound out 2x, 8x and 40x: exactly one panel every time.
  for (const extent of [900, 1800, 7200, 36_000]) {
    assert.equal(travelInPanels(extent), 1, `width ${extent}`);
  }

  // Wound *in*, the view is the smaller thing and the travel is the drawing's
  // own size instead — which is what lets its far corners be reached.
  assert.equal(travelInPanels(60), fitted.width / 60);

  // The old rule's answer, for the record: `fitted.width / extent`, which is
  // 1 fitted, 0.125 wound out eight times, and 0.025 wound out forty.
  assert.ok(fitted.width / 36_000 < 0.03);
});

test('however far it is dragged, the drawing is never lost', () => {
  for (const extent of [60, 900, 7200]) {
    for (const x of [-1e6, -extent, 0, fitted.width, 1e6]) {
      const view = clampPan({ x, y: 0, width: extent, height: extent }, fitted);
      assert.ok(
        overlap(view.x, view.width, fitted.width) > 0,
        `width ${extent} dragged to ${x} still shows part of the drawing`,
      );
    }
  }
});
