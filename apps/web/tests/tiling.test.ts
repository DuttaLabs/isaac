import assert from 'node:assert/strict';
import test from 'node:test';
import { cssLength, cssRect, tile, type Extent } from '../src/lib/tiling.ts';
import {
  DEFAULT_WORKSPACE,
  closePane,
  splitPane,
  type LayoutNode,
  type Workspace,
} from '../src/lib/workspace.ts';

const GUTTER = 10;
const INSET = 12;

/** A length resolved against a container of `size` pixels. */
const resolve = (extent: Extent, size: number): number => extent.fraction * size + extent.pixels;

const lone: LayoutNode = { kind: 'pane', key: 'p1', panel: 'system' };

test('one pane fills the workspace, inset all round', () => {
  const { panes, splitters } = tile(lone, GUTTER, INSET);
  assert.equal(splitters.length, 0);
  assert.equal(panes.length, 1);

  const rect = panes[0]!.rect;
  assert.equal(resolve(rect.left, 1000), INSET);
  assert.equal(resolve(rect.top, 800), INSET);
  assert.equal(resolve(rect.width, 1000), 1000 - 2 * INSET);
  assert.equal(resolve(rect.height, 800), 800 - 2 * INSET);
});

test('a split divides what is left after the divider has taken its width', () => {
  const two = splitPane({ root: lone, nextKey: 1 }, 'p1', 'row');
  const { panes, splitters } = tile(two.root, GUTTER, INSET);
  const width = 1000;
  const usable = width - 2 * INSET - GUTTER;

  const [first, second] = panes;
  assert.equal(resolve(first!.rect.width, width), usable / 2);
  assert.equal(resolve(second!.rect.width, width), usable / 2);

  // No overlap and no gap: the divider sits exactly between them.
  const divider = splitters[0]!;
  assert.equal(resolve(divider.rect.left, width), resolve(first!.rect.left, width) + usable / 2);
  assert.equal(resolve(divider.rect.width, width), GUTTER);
  assert.equal(resolve(second!.rect.left, width), resolve(divider.rect.left, width) + GUTTER);

  // A divider's span is what the two children share — the split minus the
  // divider itself — because that is what the ratio divides, so a drag measured
  // against it moves the divider exactly as far as the pointer went.
  assert.equal(resolve(divider.span, width), usable);
});

test('the panes tile the workspace exactly, at every depth', () => {
  const width = 1600;
  const height = 900;
  const { panes, splitters } = tile(DEFAULT_WORKSPACE.root, GUTTER, INSET);

  // Every pane inside the inset area, and none of them overlapping.
  const boxes = panes.map(({ rect }) => ({
    x0: resolve(rect.left, width),
    y0: resolve(rect.top, height),
    x1: resolve(rect.left, width) + resolve(rect.width, width),
    y1: resolve(rect.top, height) + resolve(rect.height, height),
  }));
  for (const box of boxes) {
    assert.ok(box.x0 >= INSET - 1e-9 && box.x1 <= width - INSET + 1e-9, 'inside horizontally');
    assert.ok(box.y0 >= INSET - 1e-9 && box.y1 <= height - INSET + 1e-9, 'inside vertically');
    assert.ok(box.x1 > box.x0 && box.y1 > box.y0, 'has some area');
  }
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const overlaps = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      assert.equal(overlaps, false, 'no two panes overlap');
    }
  }

  // The gaps between them are exactly the dividers: pane area plus divider area
  // accounts for the whole inset workspace.
  const paneArea = boxes.reduce((sum, b) => sum + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  const dividerArea = splitters.reduce(
    (sum, { rect }) => sum + resolve(rect.width, width) * resolve(rect.height, height),
    0,
  );
  const whole = (width - 2 * INSET) * (height - 2 * INSET);
  assert.ok(Math.abs(paneArea + dividerArea - whole) < 1e-6, 'panes and dividers fill it exactly');
});

test('closing a pane leaves the survivors in the order they were in', () => {
  // What the flat list rests on: React inserts and removes, and never has to
  // *move* a pane — which would lose its scroll position just as a rebuild does.
  const before = tile(DEFAULT_WORKSPACE.root, GUTTER, INSET).panes.map((p) => p.pane.key);
  const closed: Workspace = closePane(DEFAULT_WORKSPACE, 'pane-first-order');
  const after = tile(closed.root, GUTTER, INSET).panes.map((p) => p.pane.key);

  assert.deepEqual(
    after,
    before.filter((key) => key !== 'pane-first-order'),
  );
});

test('a length is written as valid CSS on both signs', () => {
  // `calc(50% + -5px)` is not valid, so the sign is chosen rather than printed.
  assert.equal(cssLength({ fraction: 0.5, pixels: -5 }), 'calc(50% - 5px)');
  assert.equal(cssLength({ fraction: 0.25, pixels: 7 }), 'calc(25% + 7px)');
  assert.equal(cssLength({ fraction: 0, pixels: 12 }), 'calc(0% + 12px)');

  const { left, width } = cssRect(tile(lone, GUTTER, INSET).panes[0]!.rect);
  assert.equal(left, 'calc(0% + 12px)');
  assert.equal(width, 'calc(100% - 24px)');
});
