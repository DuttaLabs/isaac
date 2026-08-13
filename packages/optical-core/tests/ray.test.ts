import assert from 'node:assert/strict';
import test from 'node:test';
import { Point3, Ray, Vector3 } from '../src/index.ts';

test('Ray normalizes its direction and evaluates points along itself', () => {
  const ray = new Ray(new Point3(1, 2, 3), new Vector3(0, 0, 8), { wavelengthNm: 546.1 });

  assert.deepEqual(ray.direction, new Vector3(0, 0, 1));
  assert.deepEqual(ray.at(12.5), new Point3(1, 2, 15.5));
  assert.equal(ray.intensity, 1);
  assert.equal(ray.opticalPathLength, 0);
  assert.equal(ray.medium, 'AIR');
  assert.equal(ray.status, 'ACTIVE');
});

test('Ray.with produces independent, re-normalized copies', () => {
  const ray = new Ray(new Point3(0, 0, 0), new Vector3(0, 0, 1), {
    wavelengthNm: 486.1,
    intensity: 0.8,
  });
  const next = ray.with({ direction: new Vector3(3, 0, 4), medium: 'N-BK7', opticalPathLength: 5 });

  assert.ok(next.direction.equals(new Vector3(0.6, 0, 0.8)));
  assert.equal(next.medium, 'N-BK7');
  assert.equal(next.opticalPathLength, 5);
  assert.equal(next.intensity, 0.8); // carried forward
  assert.equal(ray.medium, 'AIR'); // original untouched
});

test('Ray validates physical inputs', () => {
  const origin = new Point3(0, 0, 0);
  const direction = new Vector3(0, 0, 1);
  assert.throws(() => new Ray(origin, direction, { wavelengthNm: 0 }), /wavelengthNm/);
  assert.throws(() => new Ray(origin, direction, { wavelengthNm: 550, intensity: -0.1 }), /intensity/);
  assert.throws(() => new Ray(origin, Vector3.zero(), { wavelengthNm: 550 }), /zero-length/);
});
