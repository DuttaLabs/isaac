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
import {
  aperturePatch,
  buildOpticalScene,
  needsAperturePatch,
  obscurationGeometry,
  surfaceProfile,
  type SceneTrace,
} from '../src/index.ts';

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
  return traceRays(system, rays).map((result) => ({ result, wavelengthIndex: 0, fieldIndex: 0 }));
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
  const traces = traceRays(system, rays).map((result) => ({
    result,
    wavelengthIndex: 0,
    fieldIndex: 1,
  }));
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

/** The same singlet, but with the object a finite distance in front of it. */
function singletWithFiniteObject(objectDistance: number): OpticalSystem {
  return new OpticalSystem({
    name: 'finite',
    wavelengthsNm: [587.5618],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    fields: [{ objectHeight: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: objectDistance, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 6,
        semiDiameter: 10,
        material: N_BK7,
      }),
      new Surface({ id: 's2', type: 'STANDARD', radius: -50, thickness: 90, semiDiameter: 10 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });
}

test('an object at infinity contributes no shell — there is nowhere to put one', () => {
  const scene = buildOpticalScene(singlet(), [], { defaultSemiDiameter: 10 });
  assert.ok(!scene.surfaces.some((shell) => shell.surfaceIndex === 0));
  scene.dispose();
});

test('a finite object plane is built, like the image plane at the other end', () => {
  const scene = buildOpticalScene(singletWithFiniteObject(200), [], { defaultSemiDiameter: 10 });
  const object = scene.surfaces.find((shell) => shell.surfaceIndex === 0);
  assert.ok(object !== undefined, 'the object plane should be built');
  assert.equal(object.isImage, false);
  assert.equal(object.isMirror, false);
  // Its geometry sits at the object's own place on the axis, one object
  // distance behind surface 1, which is at z = 0.
  const zs = vertices(object.geometry).map(([, , z]) => z);
  for (const z of zs) {
    assert.ok(Math.abs(z - -200) < 1e-6, `expected z = -200, got ${z}`);
  }
  scene.dispose();
});

test('a surface with an annular aperture is revolved from its hole, not from the axis', () => {
  const shape = { curvature: -1 / 20, conic: 0, asphericCoefficients: [] as number[] };
  const solid = surfaceProfile(shape, 0, 12, 8);
  const holed = surfaceProfile(shape, 0, 12, 8, 3);

  assert.equal(solid[0]!.x, 0);
  assert.equal(holed[0]!.x, 3);
  // Both still reach the rim: the hole takes material from the middle, not from
  // the edge.
  assert.equal(solid[solid.length - 1]!.x, 12);
  assert.equal(holed[holed.length - 1]!.x, 12);
  // The sag is the surface's own at every radius, hole or not — the shape is not
  // re-scaled to fit the ring it is now drawn over.
  assert.ok(Math.abs(holed[0]!.y - surfaceProfileSag(shape, 3)) < 1e-12);
});

test('an aperture that is not a circle is drawn over its own shape, not revolved', () => {
  const shape = { curvature: 0, conic: 0, asphericCoefficients: [] as number[] };
  const rectangular = new Surface({
    id: 'rect',
    type: 'STANDARD',
    thickness: 10,
    semiDiameter: 50,
    aperture: { kind: 'RECTANGULAR', halfWidthX: 25, halfWidthY: 10 },
  });
  assert.equal(needsAperturePatch(rectangular), true);

  const patch = aperturePatch(rectangular, 50, 4, 64);
  const points = patch.getAttribute('position');
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < points.count; i += 1) {
    maxX = Math.max(maxX, Math.abs(points.getX(i)));
    maxY = Math.max(maxY, Math.abs(points.getY(i)));
  }
  // The rectangle's own proportions, not a disc of one radius: a lathe would
  // have made both of these 25, which is the silent wrongness this replaces.
  assert.ok(Math.abs(maxX - 25) < 0.2, `reached ${maxX} across x, expected 25`);
  assert.ok(Math.abs(maxY - 10) < 0.2, `reached ${maxY} across y, expected 10`);
  assert.ok(shape.curvature === 0);
});

test('a decentered aperture is drawn where the aperture is', () => {
  const offAxis = new Surface({
    id: 'oap',
    type: 'STANDARD',
    radius: -300,
    conic: -1,
    thickness: -100,
    aperture: { kind: 'CIRCULAR', maxRadius: 55, decenterY: -100 },
    reflective: true,
  });
  assert.equal(needsAperturePatch(offAxis), true);

  const points = aperturePatch(offAxis, 50, 4, 64).getAttribute('position');
  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < points.count; i += 1) {
    lowest = Math.min(lowest, points.getY(i));
    highest = Math.max(highest, points.getY(i));
  }
  // Centred on the aperture at −100, reaching 55 either side of it.
  assert.ok(Math.abs(lowest + 155) < 0.2, `bottom at ${lowest}, expected −155`);
  assert.ok(Math.abs(highest + 45) < 0.2, `top at ${highest}, expected −45`);
});

test('a centered circle is still a lathe, because a lathe draws it better', () => {
  const plain = new Surface({ id: 'p', type: 'STANDARD', thickness: 5, semiDiameter: 10 });
  assert.equal(needsAperturePatch(plain), false);
  // An annulus is a surface of revolution too, hole and all.
  assert.equal(
    needsAperturePatch(plain.with({ aperture: { kind: 'CIRCULAR', minRadius: 2, maxRadius: 9 } })),
    false,
  );
  // And an obscuration does not bound the surface at all, so it changes nothing.
  assert.equal(
    needsAperturePatch(
      plain.with({ aperture: { kind: 'RECTANGULAR_OBSCURATION', halfWidthX: 2, halfWidthY: 3 } }),
    ),
    false,
  );
});

test('an obscuration is geometry of its own, and a spider is its arms', () => {
  const shape = { curvature: 0, conic: 0, asphericCoefficients: [] as number[] };
  const baffle = new Surface({
    id: 'baffle',
    type: 'STANDARD',
    thickness: 10,
    semiDiameter: 20,
    aperture: { kind: 'CIRCULAR_OBSCURATION', maxRadius: 5 },
  });
  const disc = obscurationGeometry(baffle, 20, 4, 32);
  assert.ok(disc, 'expected the obscuration to be drawn');
  const points = disc.getAttribute('position');
  let furthest = 0;
  for (let i = 0; i < points.count; i += 1) {
    furthest = Math.max(furthest, Math.hypot(points.getX(i), points.getY(i)));
  }
  // It covers what it blocks and no more: the surface keeps its own 20.
  assert.ok(Math.abs(furthest - 5) < 0.05, `reached ${furthest}, expected the 5 it obscures`);

  // A spider is drawn as arms, so its geometry reaches the rim while covering
  // almost none of the surface between them.
  const spider = baffle.with({ aperture: { kind: 'SPIDER', armCount: 3, armWidth: 2 } });
  const vanes = obscurationGeometry(spider, 20, 4, 32)!;
  const arms = vanes.getAttribute('position');
  let reach = 0;
  for (let i = 0; i < arms.count; i += 1) {
    reach = Math.max(reach, Math.hypot(arms.getX(i), arms.getY(i)));
  }
  assert.ok(reach > 19, `arms reached ${reach}, expected the 20 rim`);
  // Three arms, two triangles per step: far fewer vertices than a full patch.
  assert.ok(arms.count < 4 * 32, `${arms.count} vertices reads more like a disc than three vanes`);

  // A surface with no obscuring aperture has nothing to draw.
  assert.equal(obscurationGeometry(baffle.with({ aperture: undefined }), 20, 4, 32), undefined);
  assert.ok(shape.curvature === 0);
});

test('a surface whose only job is to obscure is drawn as the obscuration alone', () => {
  // The dummy plane carrying a Schmidt-Cassegrain's spider: no glass, no
  // coating, no rim. Its semi-diameter is a number the program computed, and a
  // disc drawn there puts a pane in the beam that does not exist — and gives the
  // vanes something to z-fight with.
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'vanes',
        type: 'STANDARD',
        thickness: 20,
        semiDiameter: 12,
        aperture: { kind: 'SPIDER', armCount: 3, armWidth: 1 },
      }),
      new Surface({
        id: 'mirror',
        type: 'STANDARD',
        radius: -100,
        thickness: -50,
        semiDiameter: 12,
        aperture: { kind: 'CIRCULAR_OBSCURATION', maxRadius: 3 },
        reflective: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const scene = buildOpticalScene(system, [], { defaultSemiDiameter: 10 });
  const shells = new Set(scene.surfaces.map((one) => one.surfaceIndex));
  const blocked = new Set(scene.obscurations.map((one) => one.surfaceIndex));

  // The spider's plane: vanes, and no disc behind them.
  assert.ok(blocked.has(1));
  assert.ok(!shells.has(1), 'the dummy plane should not be drawn as a surface');
  // The mirror does something besides obscure, so it keeps its shell *and* gets
  // its spot: a mirror with a spot painted on it is still a mirror.
  assert.ok(shells.has(2));
  assert.ok(blocked.has(2));
  scene.dispose();
});

test("a lens's welded faces are drawn nowhere, and pointable-at separately", () => {
  const scene = buildOpticalScene(singlet(), [], { defaultSemiDiameter: 25 });

  // The two faces are revolved into one solid, so neither is among the shells:
  // there is no geometry for either in the picture itself.
  const drawn = scene.surfaces.map((shell) => shell.surfaceIndex);
  assert.ok(!drawn.includes(1), 'the front face must not be drawn on its own');
  assert.ok(!drawn.includes(2), 'nor the back');
  assert.equal(scene.elements.length, 1);

  // But each has a shell built for the table's highlight, which needs to point
  // at one surface rather than at the lens containing it.
  const faces = scene.faceShells.map((face) => face.surfaceIndex).sort();
  assert.deepEqual(faces, [1, 2]);

  // The two lists never name the same surface: a surface is drawn as part of a
  // body or on its own, never both, or the highlight would fight the picture.
  for (const face of scene.faceShells) {
    assert.ok(!drawn.includes(face.surfaceIndex), `surface ${face.surfaceIndex} is in both lists`);
  }
  scene.dispose();
});

test('a face shell sits exactly on the face it stands for', () => {
  // It is laid over the body rather than near it — which is why the view has to
  // bias it forward in depth, and why it must not be built from anything but the
  // same profile the solid was.
  const scene = buildOpticalScene(singlet(), [], { defaultSemiDiameter: 25 });
  const front = scene.faceShells.find((face) => face.surfaceIndex === 1);
  assert.ok(front !== undefined);

  const points = vertices(front.geometry);
  assert.ok(points.length > 0);
  const system = singlet();
  const shape = system.surfaceAt(1).shape;
  const vertexZ = system.vertexZAt(1);
  for (const [x, y, z] of points) {
    const sag = surfaceProfileSag(shape, Math.hypot(x, y));
    assert.ok(
      Math.abs(z - (vertexZ + sag)) < 1e-6,
      `point at r=${Math.hypot(x, y).toFixed(3)} sits at z=${z}, not ${vertexZ + sag}`,
    );
  }
  scene.dispose();
});
