import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3, angleOfIncidence, reflect, refract } from '../src/index.ts';

const deg = (d: number): number => (d * Math.PI) / 180;

test('refraction obeys Snell law across an air→glass plane', () => {
  const incidence = deg(30);
  const d = new Vector3(Math.sin(incidence), 0, Math.cos(incidence));
  const normal = new Vector3(0, 0, 1);

  const refracted = refract(d, normal, 1, 1.5);
  assert.ok(refracted);
  // n1 sinθ1 = n2 sinθ2  →  sinθ2 = sin30 / 1.5 = 1/3.
  const sinTheta2 = refracted.x;
  assert.ok(Math.abs(sinTheta2 - 1 / 3) < 1e-12);
  assert.ok(refracted.equals(new Vector3(1 / 3, 0, Math.sqrt(1 - 1 / 9)), 1e-12));
  assert.ok(Math.abs(refracted.length - 1) < 1e-12);
});

test('a ray at normal incidence passes straight through', () => {
  const refracted = refract(new Vector3(0, 0, 1), new Vector3(0, 0, 1), 1, 1.5);
  assert.ok(refracted);
  assert.ok(refracted.equals(new Vector3(0, 0, 1), 1e-12));
});

test('total internal reflection returns null past the critical angle', () => {
  // Critical angle for 1.5→1 is ~41.8°; 50° exceeds it.
  const incidence = deg(50);
  const d = new Vector3(Math.sin(incidence), 0, Math.cos(incidence));
  assert.equal(refract(d, new Vector3(0, 0, 1), 1.5, 1), null);
});

test('reflection mirrors the axial component', () => {
  const d = new Vector3(Math.sin(deg(30)), 0, Math.cos(deg(30)));
  const r = reflect(d, new Vector3(0, 0, 1));
  assert.ok(r.equals(new Vector3(Math.sin(deg(30)), 0, -Math.cos(deg(30))), 1e-12));
});

test('angleOfIncidence measures against the surface normal', () => {
  const d = new Vector3(Math.sin(deg(30)), 0, Math.cos(deg(30)));
  assert.ok(Math.abs(angleOfIncidence(d, new Vector3(0, 0, 1)) - deg(30)) < 1e-12);
});
