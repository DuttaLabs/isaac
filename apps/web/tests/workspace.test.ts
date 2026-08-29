import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE,
  MINIMUM_RATIO,
  addFirstPanel,
  closePane,
  findPane,
  isEmpty,
  panelsOnScreen,
  panesInOrder,
  resizeSplit,
  setPanePanel,
  splitPane,
  type LayoutNode,
  type Split,
  type Workspace,
} from '../src/lib/workspace.ts';

const one: Workspace = {
  root: { kind: 'pane', key: 'p1', panel: 'system' },
  nextKey: 1,
};

/** The shape of a tree, for comparing arrangements without their keys. */
function shape(node: LayoutNode): unknown {
  return node.kind === 'pane'
    ? (node.panel ?? '(blank)')
    : { [node.direction]: [shape(node.first), shape(node.second)] };
}

const keys = (workspace: Workspace): string[] => panesInOrder(workspace).map((found) => found.key);

test('the default layout is the arrangement Isaac has always opened with', () => {
  assert.deepEqual(
    panesInOrder(DEFAULT_WORKSPACE).map((found) => found.panel),
    ['source', 'system', 'firstOrder', 'layout2d', 'rayFan', 'spot'],
  );
  assert.equal(isEmpty(DEFAULT_WORKSPACE), false);
});

test('splitting a pane leaves it where it is and puts a blank one beside it', () => {
  const right = splitPane(one, 'p1', 'row');
  assert.deepEqual(shape(right.root), { row: ['system', '(blank)'] });

  const down = splitPane(one, 'p1', 'column');
  assert.deepEqual(shape(down.root), { column: ['system', '(blank)'] });

  // The pane keeps its key, so it keeps its React identity, its scroll position
  // and its place in the second window.
  assert.equal(keys(right)[0], 'p1');
  assert.equal((right.root as Split).ratio, 0.5);
});

test('every split gets a key of its own, so two splits of one pane never collide', () => {
  const once = splitPane(one, 'p1', 'row');
  const twice = splitPane(once, 'p1', 'column');
  const paneKeys = keys(twice);
  assert.equal(new Set(paneKeys).size, paneKeys.length);
  assert.equal(twice.nextKey, 3);
  // The second split went inside the first, where the pane now is.
  assert.deepEqual(shape(twice.root), { row: [{ column: ['system', '(blank)'] }, '(blank)'] });
});

test('splitting a pane that is not there changes nothing at all', () => {
  assert.equal(splitPane(one, 'nobody', 'row'), one);
});

test('nothing outside a split moves', () => {
  const before = DEFAULT_WORKSPACE;
  const after = splitPane(before, 'pane-spot', 'row');
  // The whole left branch is the very same object, so React re-renders only the
  // branch that actually moved.
  assert.equal(
    (after.root as Split).first,
    (before.root as Split).first,
    'the untouched half should be the same object',
  );
});

test('closing a pane gives its space to its sibling and to nothing else', () => {
  // Three rows written as a tree: A over (B over C).
  const three: Workspace = {
    root: {
      kind: 'split',
      key: 's1',
      direction: 'column',
      ratio: 0.4,
      first: { kind: 'pane', key: 'a', panel: 'source' },
      second: {
        kind: 'split',
        key: 's2',
        direction: 'column',
        ratio: 0.5,
        first: { kind: 'pane', key: 'b', panel: 'system' },
        second: { kind: 'pane', key: 'c', panel: 'firstOrder' },
      },
    },
    nextKey: 1,
  };

  // B goes: C takes the whole of the lower half. A does not move a pixel — the
  // split above it still divides at 0.4.
  const withoutB = closePane(three, 'b');
  assert.deepEqual(shape(withoutB.root), { column: ['source', 'firstOrder'] });
  assert.equal((withoutB.root as Split).ratio, 0.4);

  // A goes: the lower pair takes everything, keeping the proportions it had.
  const withoutA = closePane(three, 'a');
  assert.deepEqual(shape(withoutA.root), { column: ['system', 'firstOrder'] });
  assert.equal((withoutA.root as Split).ratio, 0.5);
});

test('closing the last pane blanks it rather than leaving nothing', () => {
  const emptied = closePane(one, 'p1');
  assert.equal(isEmpty(emptied), true);
  assert.equal(panesInOrder(emptied).length, 1);
  // And it is recoverable, which is the whole reason it is not removed.
  assert.equal(isEmpty(addFirstPanel(emptied, 'layout2d')), false);
  assert.deepEqual(panelsOnScreen(addFirstPanel(emptied, 'layout2d')), new Set(['layout2d']));
});

test('closing every pane one at a time ends somewhere the user can recover from', () => {
  let workspace = DEFAULT_WORKSPACE;
  for (const found of panesInOrder(DEFAULT_WORKSPACE)) {
    workspace = closePane(workspace, found.key);
  }
  assert.equal(isEmpty(workspace), true);
});

test('closing a pane that is not there changes nothing at all', () => {
  assert.equal(closePane(one, 'nobody'), one);
  assert.equal(closePane(DEFAULT_WORKSPACE, 'nobody'), DEFAULT_WORKSPACE);
});

test('a divider moves only its own split, and cannot squeeze either side away', () => {
  const two = splitPane(one, 'p1', 'row');
  const key = (two.root as Split).key;

  assert.equal((resizeSplit(two, key, 0.2).root as Split).ratio, 0.7);
  assert.equal((resizeSplit(two, key, -0.2).root as Split).ratio, 0.3);

  // A panel dragged to nothing could never be dragged back: there would be no
  // edge left to grab.
  assert.equal((resizeSplit(two, key, -5).root as Split).ratio, MINIMUM_RATIO);
  assert.equal((resizeSplit(two, key, 5).root as Split).ratio, 1 - MINIMUM_RATIO);
});

test('a divider leaves every other split where it was', () => {
  const before = DEFAULT_WORKSPACE.root as Split;
  const after = resizeSplit(DEFAULT_WORKSPACE, 'split-right', 0.1).root as Split;
  assert.equal(after.ratio, before.ratio);
  assert.equal(after.first, before.first);
  assert.equal((after.second as Split).ratio, 0.7);
});

test('a pane can be turned over to another panel, and its neighbours are untouched', () => {
  const changed = setPanePanel(DEFAULT_WORKSPACE, 'pane-spot', 'layout3d');
  assert.equal(findPane(changed, 'pane-spot')?.panel, 'layout3d');
  assert.deepEqual(
    panesInOrder(changed).map((found) => found.panel),
    ['source', 'system', 'firstOrder', 'layout2d', 'rayFan', 'layout3d'],
  );
});

test('the same panel may be open more than once, and the copies are separate panes', () => {
  const twice = setPanePanel(splitPane(DEFAULT_WORKSPACE, 'pane-spot', 'row'), 'pane-1', 'system');
  const panels = panesInOrder(twice).map((found) => found.panel);
  assert.equal(panels.filter((panel) => panel === 'system').length, 2);
  // One panel, two panes: only the key can tell them apart, which is why every
  // operation names the pane and never the panel.
  assert.equal(panelsOnScreen(twice).size, 6);
});

test('a blank pane is on screen but shows nothing', () => {
  const split = splitPane(DEFAULT_WORKSPACE, 'pane-spot', 'column');
  assert.equal(panesInOrder(split).length, 7);
  assert.equal(panelsOnScreen(split).size, 6);
  assert.equal(findPane(split, 'pane-1')?.panel, undefined);
});
