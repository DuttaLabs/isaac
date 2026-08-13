import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from '../src/index.ts';

test('Vector3 supports immutable arithmetic', () => {
  const a = new Vector3(1, 2, 3);
  const b = new Vector3(-4, 5, 6);

  assert.deepEqual(a.add(b), new Vector3(-3, 7, 9));
  assert.deepEqual(a.subtract(b), new Vector3(5, -3, -3));
  assert.deepEqual(a.scale(2), new Vector3(2, 4, 6));
  assert.deepEqual(a.negate(), new Vector3(-1, -2, -3));
  assert.deepEqual(a, new Vector3(1, 2, 3)); // originals untouched
});

test('Vector3 computes dot, cross, length, and normalization', () => {
  const v = new Vector3(3, 4, 0);
  assert.equal(v.lengthSquared, 25);
  assert.equal(v.length, 5);
  assert.ok(v.normalized().equals(new Vector3(0.6, 0.8, 0)));
  assert.equal(new Vector3(1, 0, 0).dot(new Vector3(0, 1, 0)), 0);
  assert.deepEqual(new Vector3(1, 0, 0).cross(new Vector3(0, 1, 0)), new Vector3(0, 0, 1));
});

test('Vector3 rejects zero-length normalization and non-finite inputs', () => {
  assert.throws(() => Vector3.zero().normalized(), /zero-length/);
  assert.throws(() => new Vector3(NaN, 0, 0), /finite/);
  assert.throws(() => new Vector3(0, Infinity, 0), /finite/);
});
