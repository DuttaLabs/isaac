import assert from 'node:assert/strict';
import test from 'node:test';
import { Point3, Vector3, intersectSphericalSurface } from '../src/index.ts';

const dirZ = Vector3.unitZ();

test('on-axis ray meets a spherical surface at its vertex', () => {
  const hit = intersectSphericalSurface(new Point3(0, 0, -10), dirZ, 1 / 50);
  assert.ok(hit);
  assert.ok(Math.abs(hit.distance - 10) < 1e-12);
  assert.ok(hit.point.equals(new Point3(0, 0, 0), 1e-12));
  // At the vertex a convex (R>0) surface normal points back toward the object (−Z).
  assert.ok(hit.normal.equals(new Vector3(0, 0, -1), 1e-12));
});

test('off-axis intersection lands on the spherical cap (sag)', () => {
  const hit = intersectSphericalSurface(new Point3(0, 20, -10), dirZ, 1 / 50);
  assert.ok(hit);
  const sag = 50 - Math.sqrt(2500 - 400); // z of the cap at r = 20
  assert.ok(Math.abs(hit.point.z - sag) < 1e-9);
  assert.ok(Math.abs(hit.distance - (sag + 10)) < 1e-9);
  // Normal = (point − centre) / R, centre at (0,0,50).
  const expectedNormal = new Vector3(0, 20, sag - 50).normalized();
  assert.ok(hit.normal.equals(expectedNormal, 1e-9));
});

test('negative radius picks the vertex-side cap, not the far sphere', () => {
  const hit = intersectSphericalSurface(new Point3(0, 0, -10), dirZ, -1 / 50);
  assert.ok(hit);
  assert.ok(Math.abs(hit.distance - 10) < 1e-12); // vertex at z=0, not z=-100
  // Centre of curvature is at −Z, so the outward normal at the vertex points +Z.
  assert.ok(hit.normal.equals(new Vector3(0, 0, 1), 1e-12));
});

test('plane surface intersects at z = 0 with a +Z normal', () => {
  const hit = intersectSphericalSurface(new Point3(0, 5, -3), dirZ, 0);
  assert.ok(hit);
  assert.ok(Math.abs(hit.distance - 3) < 1e-12);
  assert.ok(hit.point.equals(new Point3(0, 5, 0), 1e-12));
  assert.ok(hit.normal.equals(new Vector3(0, 0, 1), 1e-12));
});

test('rays that miss the sphere or run parallel to a plane return null', () => {
  assert.equal(intersectSphericalSurface(new Point3(0, 100, -10), dirZ, 1 / 50), null);
  assert.equal(intersectSphericalSurface(new Point3(0, 0, -3), new Vector3(0, 1, 0), 0), null);
});
