import assert from 'node:assert/strict';
import test from 'node:test';
import { MENU_EDGE_MARGIN, placeMenu } from '../src/lib/context-menu.ts';

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 200, height: 120 };

test('a menu with room opens down and right from the pointer', () => {
  assert.deepEqual(placeMenu({ x: 300, y: 200 }, MENU, VIEWPORT), { x: 300, y: 200 });
});

test('a menu near an edge flips to the other side of the pointer', () => {
  // Flipped, not slid: the pointer stays on a corner of the menu rather than
  // landing in the middle of it, on an item nobody aimed at.
  const placed = placeMenu({ x: 950, y: 760 }, MENU, VIEWPORT);
  assert.deepEqual(placed, { x: 950 - MENU.width, y: 760 - MENU.height });
});

test('each axis is decided on its own', () => {
  assert.deepEqual(placeMenu({ x: 950, y: 200 }, MENU, VIEWPORT), { x: 750, y: 200 });
  assert.deepEqual(placeMenu({ x: 300, y: 760 }, MENU, VIEWPORT), { x: 300, y: 640 });
});

test('a menu that fits nowhere is clamped to the near edge rather than flipped off it', () => {
  // Taller than the window it is in: flipping would put its top above the
  // viewport, where the first item is unreachable.
  const tall = { width: 200, height: 900 };
  const placed = placeMenu({ x: 300, y: 700 }, tall, VIEWPORT);
  assert.equal(placed.y, MENU_EDGE_MARGIN);
});

test('a menu opened at the very corner stays inside the window', () => {
  const placed = placeMenu({ x: 0, y: 0 }, MENU, VIEWPORT);
  assert.ok(placed.x >= MENU_EDGE_MARGIN);
  assert.ok(placed.y >= MENU_EDGE_MARGIN);
});

test('a flip that would still touch the edge is pulled back off it', () => {
  // The pointer is in the last pixel column, so flipping leaves the menu's right
  // edge one pixel from the window's — flush against it, which reads as clipped.
  const placed = placeMenu({ x: VIEWPORT.width - 1, y: 100 }, MENU, VIEWPORT);
  assert.equal(placed.x, VIEWPORT.width - MENU.width - MENU_EDGE_MARGIN);
});
