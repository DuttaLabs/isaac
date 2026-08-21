import assert from 'node:assert/strict';
import test from 'node:test';
import type { BufferGeometry } from 'three';
import {
  AIR,
  N_BK7,
  OpticalSystem,
  Surface,
  generateRayFan,
  sphericalShape,
  surfaceProfileSag,
  traceRays,
} from '@isaac/optical-core';
import { buildOpticalScene, surfaceProfile, type SceneTrace } from '../src/index.ts';

/** A biconvex singlet in air: one glass element, an image plane, nothing else. */
function singlet(): OpticalSystem {
  return new OpticalSystem({
    name: 'singlet',
    wavelengthsNm: [587.5618],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    fields: [{ angleDeg: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 6,
        semiDiameter: 10,
        material: N_BK7,
        isStop: true,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: -50,
        thickness: 45,
        semiDiameter: 10,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 8, material: AIR }),
    ],
  });
}

function tracesFor(system: OpticalSystem): SceneTrace[] {
  const rays = generateRayFan(system, { field: 0, wavelengthNm: 587.5618, count: 5 });
  return traceRays(system, rays).map((result) => ({ result, wavelengthIndex: 0 }));
}

/** Reads a geometry's vertices back as [x, y, z] triples. */
function vertices(geometry: BufferGeometry): [number, number, number][] {
  const position = geometry.getAttribute('position');
  assert.ok(position, 'a drawn geometry must carry positions');
  const out: [number, number, number][] = [];
  for (let i = 0; i < position.count; i += 1) {
    out.push([position.getX(i), position.getY(i), position.getZ(i)]);
  }
  return out;
}

test('a revolved surface has the optical axis along +Z', () => {
  // Lathe geometry revolves about Y. If the quarter turn were missing or the
  // wrong way, a plane at z = 12 would come out as a disc standing in the wrong
  // plane, and every layout would be drawn side-on.
  const system = singlet();
  const scene = buildOpticalScene(system, [], { defaultSemiDiameter: 10 });

  const image = scene.surfaces.find((shell) => shell.isImage);
  assert.ok(image, 'the image plane is not part of an element, so it is drawn on its own');

  const imageZ = system.vertexZAt(system.surfaces.length - 1);
  for (const [x, y, z] of vertices(image.geometry)) {
    assert.ok(Math.abs(z - imageZ) < 1e-6, `a plane surface must be flat in z: got ${z}`);
    assert.ok(Math.hypot(x, y) <= 8 + 1e-6, 'and must stay inside its semi-diameter');
  }
  scene.dispose();
});

test('a curved surface bulges the way its radius says', () => {
  const system = singlet();
  const scene = buildOpticalScene(system, [], { defaultSemiDiameter: 10 });

  // The singlet is one solid, so its front surface is the element's, not a shell.
  assert.equal(scene.elements.length, 1);
  assert.equal(scene.elements[0]!.frontIndex, 1);
  assert.equal(scene.elements[0]!.backIndex, 2);

  // R 50 convex toward −Z: at the rim the surface is sag() behind its vertex.
  const expected = 50 - Math.sqrt(50 * 50 - 10 * 10);
  assert.ok(
    Math.abs(surfaceProfileSag(sphericalShape(1 / 50), 10) - expected) < 1e-12,
    'sag must match the circle',
  );

  const zs = vertices(scene.elements[0]!.geometry).map(([, , z]) => z);
  assert.ok(Math.abs(Math.min(...zs) - 0) < 1e-6, 'the front vertex sits at z = 0');
  assert.ok(Math.abs(Math.max(...zs) - 6) < 1e-6, 'and the rear vertex at the center thickness, 6');
  scene.dispose();
});

test('an element is a closed solid, not two loose caps', () => {
  // The profile has to start and end on the axis: those two poles are what turn
  // a revolution into a solid. If either end were off-axis the lens would be a
  // tube with open ends, which is visible the moment you orbit behind it.
  const front = surfaceProfile(sphericalShape(1 / 50), 0, 10, 8);
  const back = surfaceProfile(sphericalShape(-1 / 50), 6, 10, 8);
  const profile = [...front, ...back.reverse()];

  assert.equal(profile[0]!.x, 0, 'starts on the axis');
  assert.equal(profile[profile.length - 1]!.x, 0, 'ends on the axis');
  assert.ok(
    profile.every((point) => point.x >= 0),
    'a lathe profile never crosses the axis',
  );
});

test('a plane surface profile is flat and a curved one is not', () => {
  const flat = surfaceProfile(sphericalShape(0), 3, 5, 6);
  assert.ok(
    flat.every((point) => Math.abs(point.y - 3) < 1e-12),
    'zero curvature is a plane at the vertex',
  );

  const curved = surfaceProfile(sphericalShape(1 / 25), 0, 5, 6);
  assert.equal(curved[0]!.y, 0, 'the vertex is on the axis at z = 0');
  assert.ok(curved[curved.length - 1]!.y > 0, 'and the rim is displaced by the sag');
});

test('an impossible element is marked, as it is in the 2-D layout', () => {
  // Semi-diameter 26.68 against 7 mm of thickness: the same case the corpus
  // triage found in 5852515c.zmx, where the rear surface passes in front of the
  // front one before reaching the rim.
  const crossed = new OpticalSystem({
    name: 'crossed',
    wavelengthsNm: [587.5618],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    fields: [{ angleDeg: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 44.165,
        thickness: 7,
        semiDiameter: 26.68,
        material: N_BK7,
        isStop: true,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: 200.473,
        thickness: 50,
        semiDiameter: 26.73,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10, material: AIR }),
    ],
  });

  const scene = buildOpticalScene(crossed, [], { defaultSemiDiameter: 10 });
  assert.equal(scene.elements[0]!.crossed, true);
  scene.dispose();

  const fine = buildOpticalScene(singlet(), [], { defaultSemiDiameter: 10 });
  assert.equal(fine.elements[0]!.crossed, false, 'an ordinary singlet is not flagged');
  fine.dispose();
});

test('rays are merged into one buffer per wavelength and fate', () => {
  const system = singlet();
  const traces = tracesFor(system);
  const scene = buildOpticalScene(system, traces, { defaultSemiDiameter: 10 });

  assert.ok(scene.rays.length >= 1 && scene.rays.length <= 2, 'one group per fate, at most two');
  const total = scene.rays.reduce((sum, bundle) => sum + bundle.segmentCount, 0);
  // Each ray of this system crosses three surfaces, so its path is the launch
  // point plus three hits: three segments.
  assert.equal(total, traces.length * 3);

  for (const bundle of scene.rays) {
    assert.equal(bundle.geometry.attributes.position!.count, bundle.segmentCount * 2);
    assert.equal(bundle.wavelengthIndex, 0);
  }
  scene.dispose();
});

test('rays keep the three dimensions the engine traced them in', () => {
  // A skew field: its rays leave the meridional plane, and a 3-D layout that
  // silently flattened them would be indistinguishable from the 2-D one.
  const system = singlet().with({ fields: [{ angleDeg: 0 }, { angleDeg: 5 }] });
  const rays = generateRayFan(system, {
    field: { angleDeg: 5 },
    wavelengthNm: 587.5618,
    count: 5,
  });
  const traces = traceRays(system, rays).map((result) => ({ result, wavelengthIndex: 0 }));
  const scene = buildOpticalScene(system, traces, { defaultSemiDiameter: 10 });

  const ys = scene.rays.flatMap((bundle) => vertices(bundle.geometry).map(([, y]) => Math.abs(y)));
  assert.ok(Math.max(...ys) > 1, 'an off-axis field must show ray height off the axis');
  scene.dispose();
});

test('bounds cover the glass and the rays, ready to frame a camera', () => {
  const system = singlet();
  const scene = buildOpticalScene(system, tracesFor(system), { defaultSemiDiameter: 10 });
  const { min, max } = scene.bounds;

  assert.ok(min[2] < 0, 'rays start in front of the first surface');
  const imageZ = system.vertexZAt(system.surfaces.length - 1);
  assert.ok(max[2] >= imageZ - 1e-9, 'and the box reaches the image plane');
  assert.ok(max[0] >= 10 && max[1] >= 10, 'the aperture sets the transverse extent');
  assert.equal(min[0], -max[0], 'the system is rotationally symmetric, so the box is centered');
  scene.dispose();
});

test('a surface with no aperture still gets drawn, at the fallback size', () => {
  const unapertured = singlet().withSurfaceAt(
    3,
    new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
  );
  const scene = buildOpticalScene(unapertured, [], { defaultSemiDiameter: 7 });

  const image = scene.surfaces.find((shell) => shell.isImage)!;
  const radii = vertices(image.geometry).map(([x, y]) => Math.hypot(x, y));
  assert.ok(
    Math.max(...radii) <= 7 + 1e-6,
    'an infinite aperture falls back rather than blowing up',
  );
  assert.ok(Math.max(...radii) > 6.9, 'and uses the whole fallback');
  scene.dispose();
});

test('a revolved profile carries the conic and the aspheric terms', () => {
  const radius = 50;
  const rim = 10;
  const conic = surfaceProfile(
    { curvature: 1 / radius, conic: -1, asphericCoefficients: [] },
    0,
    rim,
    8,
  );
  const sphere = surfaceProfile(sphericalShape(1 / radius), 0, rim, 8);

  // Same vertex, different rim: the profile is being built from the shape and
  // not from the radius alone.
  assert.equal(conic[0]!.y, sphere[0]!.y);
  assert.ok(conic[conic.length - 1]!.y < sphere[sphere.length - 1]!.y);
  assert.ok(Math.abs(conic[conic.length - 1]!.y - (rim * rim) / (2 * radius)) < 1e-12);

  const asphere = surfaceProfile(
    { curvature: 1 / radius, conic: -1, asphericCoefficients: [0, 1e-5] },
    0,
    rim,
    8,
  );
  assert.ok(
    Math.abs(asphere[asphere.length - 1]!.y - (conic[conic.length - 1]!.y + 1e-5 * rim ** 4)) <
      1e-12,
  );
});
