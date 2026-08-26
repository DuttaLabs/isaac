import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WORKSPACE,
  addFirstPanel,
  closeSlot,
  duplicateSlot,
  isEmpty,
  panelsOnScreen,
  resizeColumns,
  resizeSlots,
  setSlotPanel,
  slotsInOrder,
  type Workspace,
} from '../src/lib/workspace.ts';

const keys = (workspace: Workspace): string[] => slotsInOrder(workspace).map((slot) => slot.key);
const panels = (workspace: Workspace): string[] =>
  slotsInOrder(workspace).map((slot) => slot.panel);

test('a slot takes whatever panel it is given, and no other slot moves', () => {
  const next = setSlotPanel(DEFAULT_WORKSPACE, 'slot-a', 'analysis');
  assert.deepEqual(panels(next), ['analysis', 'system', 'firstOrder', 'layout2d', 'analysis']);
});

test('the same panel may be shown twice', () => {
  // The whole point of dropping the exchange: two Source object panels are a
  // thing someone may want, one of them in the second window.
  const next = setSlotPanel(DEFAULT_WORKSPACE, 'slot-d', 'source');
  assert.equal(panels(next).filter((panel) => panel === 'source').length, 2);
});

test('a panel may be closed until none is left', () => {
  let workspace = DEFAULT_WORKSPACE;
  for (const key of keys(DEFAULT_WORKSPACE)) {
    workspace = closeSlot(workspace, key);
  }
  assert.equal(isEmpty(workspace), true);
  assert.deepEqual(workspace.columns, []);
});

test('closing the last slot of a column drops the column, not just the slot', () => {
  let workspace = closeSlot(DEFAULT_WORKSPACE, 'slot-d');
  workspace = closeSlot(workspace, 'slot-e');
  assert.equal(workspace.columns.length, 1);
  assert.deepEqual(panels(workspace), ['source', 'system', 'firstOrder']);
});

test('an emptied workspace can be filled again', () => {
  let workspace = DEFAULT_WORKSPACE;
  for (const key of keys(DEFAULT_WORKSPACE)) {
    workspace = closeSlot(workspace, key);
  }
  const filled = addFirstPanel(workspace, 'system');
  assert.equal(isEmpty(filled), false);
  assert.deepEqual(panels(filled), ['system']);
});

test('duplicating a slot puts the copy directly beneath it', () => {
  const next = duplicateSlot(DEFAULT_WORKSPACE, 'slot-a');
  assert.deepEqual(panels(next), [
    'source',
    'source',
    'system',
    'firstOrder',
    'layout2d',
    'analysis',
  ]);
});

test('a duplicate takes half of its source, so no neighbour changes size', () => {
  const before = slotsInOrder(DEFAULT_WORKSPACE);
  const next = duplicateSlot(DEFAULT_WORKSPACE, 'slot-a');
  const after = slotsInOrder(next);

  const source = before.find((slot) => slot.key === 'slot-a');
  assert.ok(source);
  assert.equal(after[0]?.size, source.size / 2);
  assert.equal(after[1]?.size, source.size / 2);
  // Everything below is untouched.
  assert.equal(after[2]?.size, before[1]?.size);
  assert.equal(after[3]?.size, before[2]?.size);
});

test('every duplicate gets a key of its own', () => {
  let workspace = duplicateSlot(DEFAULT_WORKSPACE, 'slot-a');
  workspace = duplicateSlot(workspace, 'slot-a');
  const all = keys(workspace);
  assert.equal(new Set(all).size, all.length);
});

test('panelsOnScreen reports each panel once, however many slots show it', () => {
  const next = setSlotPanel(DEFAULT_WORKSPACE, 'slot-d', 'source');
  assert.deepEqual(
    [...panelsOnScreen(next)].sort(),
    ['analysis', 'firstOrder', 'source', 'system'].sort(),
  );
});

test('a panel nobody has opened is not on screen', () => {
  // What gates the 3-D trace and the Three.js bundle behind it.
  assert.equal(panelsOnScreen(DEFAULT_WORKSPACE).has('layout3d'), false);
});

test('resizing moves space between two neighbours and preserves the total', () => {
  const total = (workspace: Workspace, column: number): number =>
    (workspace.columns[column]?.slots ?? []).reduce((sum, slot) => sum + slot.size, 0);

  const before = total(DEFAULT_WORKSPACE, 0);
  const next = resizeSlots(DEFAULT_WORKSPACE, 'column-a', 0, 0.1);
  assert.ok(Math.abs(total(next, 0) - before) < 1e-9);
  assert.ok(
    (next.columns[0]?.slots[0]?.size ?? 0) > (DEFAULT_WORKSPACE.columns[0]?.slots[0]?.size ?? 0),
  );
});

test('resizing columns preserves their total too', () => {
  const sum = (workspace: Workspace): number =>
    workspace.columns.reduce((total, column) => total + column.size, 0);
  const next = resizeColumns(DEFAULT_WORKSPACE, 0, 0.1);
  assert.ok(Math.abs(sum(next) - sum(DEFAULT_WORKSPACE)) < 1e-9);
});
