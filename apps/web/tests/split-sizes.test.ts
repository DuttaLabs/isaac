import assert from 'node:assert/strict';
import test from 'node:test';
import { evenTracks, resizeTracks, trackTemplate, MINIMUM_TRACK } from '../src/lib/split-sizes.ts';

const sum = (sizes: readonly number[]): number => sizes.reduce((total, s) => total + s, 0);

test('a divider moves space between its two tracks and nowhere else', () => {
  const before = [1, 1, 1];
  const after = resizeTracks(before, 0, 0.1);

  assert.ok(after[0]! > before[0]!);
  assert.ok(after[1]! < before[1]!);
  assert.equal(after[2], before[2], 'the third track was not touched');
  assert.ok(Math.abs(sum(after) - sum(before)) < 1e-12, 'the total is unchanged');
});

test('dragging the other way moves it back', () => {
  const start = [1, 1, 1];
  const out = resizeTracks(start, 1, 0.15);
  const back = resizeTracks(out, 1, -0.15);

  for (let i = 0; i < start.length; i += 1) {
    assert.ok(Math.abs(back[i]! - start[i]!) < 1e-12, `track ${i}`);
  }
});

test('a panel cannot be squeezed to nothing, because it could not be grabbed back', () => {
  const sizes = [1, 1, 1];
  const crushed = resizeTracks(sizes, 0, -10);

  assert.ok(crushed[0]! > 0, 'still has width');
  assert.ok(crushed[0]! >= MINIMUM_TRACK * sum(sizes) - 1e-12);
  assert.ok(Math.abs(sum(crushed) - sum(sizes)) < 1e-12);

  // And from the other side.
  const stretched = resizeTracks(sizes, 0, 10);
  assert.ok(stretched[1]! >= MINIMUM_TRACK * sum(sizes) - 1e-12);
});

test('the floor is a share of the whole row, not of the pair', () => {
  // Otherwise a panel's minimum would shrink just because its neighbour is
  // small, and a narrow pair could both be squeezed to slivers.
  const sizes = [3, 0.3, 0.3];
  const after = resizeTracks(sizes, 1, -10);
  assert.ok(after[1]! > 0);
  assert.ok(Math.abs(sum(after) - sum(sizes)) < 1e-12);
});

test('a divider that does not exist changes nothing', () => {
  assert.deepStrictEqual(resizeTracks([1, 1], 1, 0.2), [1, 1], 'past the last pair');
  assert.deepStrictEqual(resizeTracks([1, 1], -1, 0.2), [1, 1]);
  assert.deepStrictEqual(resizeTracks([1], 0, 0.2), [1], 'one track has no divider');
});

test('the grid template puts a divider between every pair and nowhere else', () => {
  assert.equal(
    trackTemplate([1, 2], 10),
    'minmax(0, 1fr) 10px minmax(0, 2fr)',
    'two tracks, one divider',
  );
  assert.equal(trackTemplate([1], 10), 'minmax(0, 1fr)', 'one track, no divider');
  assert.equal((trackTemplate([1, 1, 1], 10).match(/10px/g) ?? []).length, 2);
});

test('tracks are minmax(0, …) so a panel may shrink below its content', () => {
  // A grid item's automatic minimum is its content size, which would let a wide
  // table push the column past the window and undo the page's no-scroll promise.
  assert.match(trackTemplate([1, 1], 10), /minmax\(0, 1fr\)/);
});

test('an even split is even', () => {
  assert.deepStrictEqual(evenTracks(3), [1, 1, 1]);
  assert.deepStrictEqual(evenTracks(0), []);
});
