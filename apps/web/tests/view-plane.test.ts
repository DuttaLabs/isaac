import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, N_BK7, OpticalSystem, Surface, type CoordinateTransform } from '@isaac/optical-core';
import { buildLayout } from '../src/lib/layout.ts';
import { computeLayoutTraces } from '../src/lib/analysis.ts';
import {
  outOfPlaneAxis,
  projectToPlane,
  viewPlaneAxes,
  VIEW_PLANES,
  VIEW_PLANE_IDS,
  type Axis,
  type ProjectedAxis,
  type ViewPlane,
} from '../src/lib/view-plane.ts';
import { cameraAxes } from '../src/lib/camera-axes.ts';
import { Matrix4, Quaternion, Vector3 } from 'three';

const DEFAULT_SEMI_DIAMETER = 10;

const UNIT: Record<Axis, readonly [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** right × up, worked out here rather than borrowed from the code under test. */
function cross(a: Axis, b: Axis): readonly [number, number, number] {
  const [ax, ay, az] = UNIT[a];
  const [bx, by, bz] = UNIT[b];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

test('the third axis is derived from the other two, and points where the cross product says', () => {
  for (const id of VIEW_PLANE_IDS) {
    const view = VIEW_PLANES[id];
    const expected = cross(view.horizontal, view.vertical);
    // `+ 0` because a negative axis produces −0, which deepStrictEqual counts
    // as different from 0 and which means nothing here.
    const got = UNIT[view.outward.axis].map((component) => component * view.outward.sign + 0);
    assert.deepEqual(
      got,
      [...expected],
      `${id}: right × up disagrees with the stated outward axis`,
    );
  }
});

test('each view names all three axes exactly once', () => {
  for (const id of VIEW_PLANE_IDS) {
    const view = VIEW_PLANES[id];
    assert.deepEqual(
      [view.horizontal, view.vertical, view.outward.axis].sort(),
      ['x', 'y', 'z'],
      `${id} does not account for all three axes`,
    );
  }
});

test('a plane needs two different axes', () => {
  assert.throws(() => outOfPlaneAxis('y', 'y'), RangeError);
});

test('the two cross-sections lay the optical axis along the screen; the end-on view does not', () => {
  assert.equal(VIEW_PLANES.YZ.horizontal, 'z');
  assert.equal(VIEW_PLANES.XZ.horizontal, 'z');
  assert.equal(VIEW_PLANES.YZ.axial, true);
  assert.equal(VIEW_PLANES.XZ.axial, true);
  assert.equal(VIEW_PLANES.XY.axial, false);
  // Which is the same fact as having no fan that lies in it.
  assert.equal(VIEW_PLANES.XY.fanAxis, undefined);
});

test('projecting puts the named coordinates on the screen axes', () => {
  const point = { x: 1, y: 2, z: 3 };
  assert.deepEqual(projectToPlane(point, VIEW_PLANES.YZ), { h: 3, v: 2 });
  assert.deepEqual(projectToPlane(point, VIEW_PLANES.XZ), { h: 3, v: 1 });
  assert.deepEqual(projectToPlane(point, VIEW_PLANES.XY), { h: 1, v: 2 });
});

function look(changes: Partial<CoordinateTransform>): CoordinateTransform {
  return {
    decenterX: 0,
    decenterY: 0,
    tiltXDeg: 0,
    tiltYDeg: 0,
    tiltZDeg: 0,
    tiltFirst: false,
    ...changes,
  };
}

/** A singlet, optionally preceded by a coordinate transform that shifts it. */
function singlet(shift?: Partial<CoordinateTransform>): OpticalSystem {
  const front = new Surface({
    id: 's1',
    type: 'STANDARD',
    radius: 60,
    thickness: 5,
    semiDiameter: 10,
    material: N_BK7,
    isStop: true,
  });
  const back = new Surface({
    id: 's2',
    type: 'STANDARD',
    radius: -60,
    thickness: 55,
    semiDiameter: 10,
    material: AIR,
  });
  return new OpticalSystem({
    name: 'singlet',
    wavelengthsNm: [587.5618],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 16 },
    fields: [{ angleDeg: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({ id: 'dummy', type: 'STANDARD', thickness: 10, semiDiameter: 10 }),
      ...(shift
        ? [
            new Surface({
              id: 'ct',
              type: 'COORDINATE_TRANSFORM',
              thickness: 0,
              coordinateTransform: look(shift),
            }),
          ]
        : []),
      front,
      back,
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });
}

/**
 * The middle of a drawn outline, taken as the middle of its extent rather than as
 * the mean of its points: a closed rim repeats its first point to close it, and a
 * section is sampled evenly in height but not in depth, so neither has a mean
 * that sits where the surface does.
 */
function outlineCenter(points: readonly { h: number; v: number }[]): { h: number; v: number } {
  const middle = (values: number[]): number => (Math.min(...values) + Math.max(...values)) / 2;
  return {
    h: middle(points.map((point) => point.h)),
    v: middle(points.map((point) => point.v)),
  };
}

function frontOutline(system: OpticalSystem, view: ViewPlane) {
  const { profiles } = buildLayout(system, [], DEFAULT_SEMI_DIAMETER, view);
  // Index 1 is the dummy; the element's front face is the next drawn profile.
  return profiles.find((profile) => profile.surfaceIndex >= 2)!;
}

test('a decenter shows in the plane it happened in, and in neither of the others', () => {
  const shifted = singlet({ decenterY: 4 });

  const meridional = outlineCenter(frontOutline(shifted, VIEW_PLANES.YZ).points);
  assert.ok(
    Math.abs(meridional.v - 4) < 1e-9,
    `the y–z view should show the 4 of decenter, showed ${meridional.v}`,
  );

  // Sagittally the element has not moved: a shift in y is along the viewing
  // direction there, and reporting it would be reporting the wrong axis.
  const sagittal = outlineCenter(frontOutline(shifted, VIEW_PLANES.XZ).points);
  assert.ok(Math.abs(sagittal.v) < 1e-9, `the x–z view moved by ${sagittal.v}`);

  // End-on it is up the screen, because there v is y.
  const endOn = outlineCenter(frontOutline(shifted, VIEW_PLANES.XY).points);
  assert.ok(Math.abs(endOn.v - 4) < 1e-9, `the x–y view put it at ${endOn.v}`);
  assert.ok(Math.abs(endOn.h) < 1e-9, `the x–y view moved it sideways to ${endOn.h}`);
});

test('a decenter in x is the other way round', () => {
  const shifted = singlet({ decenterX: 4 });
  assert.ok(Math.abs(outlineCenter(frontOutline(shifted, VIEW_PLANES.YZ).points).v) < 1e-9);
  assert.ok(Math.abs(outlineCenter(frontOutline(shifted, VIEW_PLANES.XZ).points).v - 4) < 1e-9);
  assert.ok(Math.abs(outlineCenter(frontOutline(shifted, VIEW_PLANES.XY).points).h - 4) < 1e-9);
});

test('end-on a surface is a closed rim, and there is no section to fill', () => {
  const system = singlet();
  const endOn = buildLayout(system, [], DEFAULT_SEMI_DIAMETER, VIEW_PLANES.XY);
  const section = buildLayout(system, [], DEFAULT_SEMI_DIAMETER, VIEW_PLANES.YZ);

  assert.equal(section.bodies.length, 1, 'the cross-section fills the glass');
  assert.equal(endOn.bodies.length, 0, 'end-on there is no glass body to draw');

  const rim = endOn.profiles.find((profile) => profile.surfaceIndex >= 2)!;
  assert.equal(rim.closed, true);
  assert.equal(section.profiles[0]!.closed, false);
  // Every point of the rim is one semi-diameter from the axis, and the outline
  // comes back to where it started.
  for (const point of rim.points) {
    assert.ok(Math.abs(Math.hypot(point.h, point.v) - 10) < 1e-9);
  }
  const first = rim.points[0]!;
  const last = rim.points[rim.points.length - 1]!;
  assert.ok(Math.hypot(last.h - first.h, last.v - first.v) < 1e-12, 'the rim does not close');
});

/** How far off the axis the drawn rays get, in the plane they were drawn in. */
function raySpread(system: OpticalSystem, view: ViewPlane, fanAxis: 'x' | 'y'): number {
  const traces = computeLayoutTraces(system, {
    raysPerFan: 5,
    wavelengthIndices: [0],
    fanAxis,
  });
  assert.ok(traces.ok);
  const { rayPaths } = buildLayout(system, traces.value, DEFAULT_SEMI_DIAMETER, view);
  assert.ok(rayPaths.length > 0, 'the fixture must actually trace some rays');
  return Math.max(...rayPaths.flatMap((path) => path.points.map((point) => Math.abs(point.v))));
}

test('a fan has to be spread along the plane it is drawn in, or it is a line on the axis', () => {
  const system = singlet();

  // The meridional fan is a flat sheet standing in the y–z plane. Seen from the
  // side it fills the picture; seen edge-on from below it is the axis and
  // nothing else, which is why the view chooses the fan rather than inheriting
  // whichever one was traced last.
  assert.ok(raySpread(system, VIEW_PLANES.YZ, 'y') > 5);
  assert.ok(
    raySpread(system, VIEW_PLANES.XZ, 'y') < 1e-9,
    'a fan spread in y has no extent at all in the x–z plane',
  );

  // Spread in x instead and the two swap over.
  assert.ok(raySpread(system, VIEW_PLANES.XZ, 'x') > 5);
  assert.ok(raySpread(system, VIEW_PLANES.YZ, 'x') < 1e-9);
});

function axisNamed(axes: readonly ProjectedAxis[], axis: Axis): ProjectedAxis {
  const found = axes.find((entry) => entry.axis === axis);
  assert.ok(found, `no ${axis} axis in the projection`);
  return found;
}

test('a 2-D view projects two axes flat onto the screen and the third straight through it', () => {
  for (const id of VIEW_PLANE_IDS) {
    const view = VIEW_PLANES[id];
    const axes = viewPlaneAxes(view);
    assert.equal(axes.length, 3);

    // Exactly along the screen's own directions — no camera turn, no
    // foreshortening, because a 2-D view has no third dimension to show.
    assert.deepEqual(
      { ...axisNamed(axes, view.horizontal) },
      { axis: view.horizontal, x: 1, y: 0, toward: 0 },
    );
    // SVG's y grows downward, so "up" is −1.
    assert.deepEqual(
      { ...axisNamed(axes, view.vertical) },
      { axis: view.vertical, x: 0, y: -1, toward: 0 },
    );

    // The third has no screen length at all: it is the one the gizmo draws as a
    // circle, with a dot when it comes at the viewer and a cross when it recedes.
    const through = axisNamed(axes, view.outward.axis);
    assert.equal(Math.hypot(through.x, through.y), 0);
    assert.equal(through.toward, view.outward.sign);
  }
});

/** A camera at `eye` looking at the origin, the way `Object3D.lookAt` builds one. */
function lookingAtOrigin(eye: [number, number, number]): Quaternion {
  const frame = new Matrix4().lookAt(
    new Vector3(...eye),
    new Vector3(0, 0, 0),
    new Vector3(0, 1, 0),
  );
  return new Quaternion().setFromRotationMatrix(frame);
}

function closeTo(got: number, want: number, what: string): void {
  assert.ok(Math.abs(got - want) < 1e-9, `${what}: ${got} ≠ ${want}`);
}

test('a camera looking down −Z sees X to the right, Y up, and Z coming at it', () => {
  const axes = cameraAxes(lookingAtOrigin([0, 0, 10]));

  const x = axisNamed(axes, 'x');
  closeTo(x.x, 1, 'X runs right');
  closeTo(x.y, 0, 'X is level');

  const y = axisNamed(axes, 'y');
  closeTo(y.y, -1, 'Y runs up the screen, which is −y in SVG');

  // The camera is on the +Z side, so +Z points out of the screen at it: a dot,
  // not a cross. Reversing this one sign draws the gizmo inside out.
  const z = axisNamed(axes, 'z');
  closeTo(z.toward, 1, 'Z comes toward the viewer');
  closeTo(Math.hypot(z.x, z.y), 0, 'Z has no screen length');
});

test('from the −X side the optical axis runs left to right, as the 3-D home view claims', () => {
  // This is the reason `HOME_DIRECTION` puts the camera on the −X side: light
  // then travels across the frame the same way it does in the 2-D layout.
  const axes = cameraAxes(lookingAtOrigin([-10, 0, 0]));

  const z = axisNamed(axes, 'z');
  closeTo(z.x, 1, '+Z runs right');
  closeTo(z.toward, 0, '+Z lies in the screen');

  // And X, which the camera is looking along, goes away from the viewer.
  const x = axisNamed(axes, 'x');
  closeTo(x.toward, -1, '+X runs into the screen');
  closeTo(Math.hypot(x.x, x.y), 0, 'X has no screen length');
});

test('every projected axis is a unit vector split between the screen and the view direction', () => {
  for (const eye of [
    [-8.6, 4.2, -2.8],
    [3, -5, 7],
    [0, 12, 0.001],
  ] as [number, number, number][]) {
    for (const projected of cameraAxes(lookingAtOrigin(eye))) {
      const length = Math.hypot(projected.x, projected.y, projected.toward);
      closeTo(length, 1, `${projected.axis} from ${eye.join(',')}`);
    }
  }
});
