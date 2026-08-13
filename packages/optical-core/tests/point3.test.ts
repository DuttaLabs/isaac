import assert from 'node:assert/strict';
import test from 'node:test';
import { Point3, Vector3 } from '../src/index.ts';

test('Point3 translates by vectors and subtracts to vectors', () => {
  const p = new Point3(2, -1, 4);
  const q = p.add(new Vector3(3, 2, -5));

  assert.deepEqual(q, new Point3(5, 1, -1));
  assert.deepEqual(q.subtract(p), new Vector3(3, 2, -5));
  assert.equal(p.distanceTo(q), Math.sqrt(9 + 4 + 25));
});

test('Point3 compares with tolerance', () => {
  const p = new Point3(1, 1, 1);
  assert.ok(p.equals(new Point3(1, 1, 1 + 1e-13)));
  assert.ok(!p.equals(new Point3(1, 1, 1.001)));
});
