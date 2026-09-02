import { Point3 } from './point3.ts';
import { Vector3 } from './vector3.ts';

/**
 * A rigid transform — a rotation followed by a translation — mapping a
 * surface's *local* frame into global coordinates.
 *
 * Until coordinate transforms existed, every surface's frame differed from the
 * global one by a translation along z alone, so a single number said everything
 * about where a surface sat. A coordinate transform re-points the axis, so the
 * general case is needed: `rotation` holds the local axes as columns, and
 * `origin` is where the local origin lands.
 *
 * Stored as nine numbers rather than a quaternion because the tracer's inner
 * loop wants the matrix directly and never interpolates between orientations.
 * Rotations are assumed orthonormal, so the inverse is the transpose — the
 * transforms are only ever built from the rotation and translation primitives
 * below, which cannot produce anything else.
 */
export class Transform3 {
  /** Row-major 3×3 rotation: `[r00, r01, r02, r10, …]`. */
  public readonly rotation: readonly number[];
  public readonly origin: Point3;

  public constructor(rotation: readonly number[], origin: Point3) {
    if (rotation.length !== 9) {
      throw new RangeError(`A 3×3 rotation needs 9 elements, got ${rotation.length}.`);
    }
    this.rotation = rotation;
    this.origin = origin;
  }

  public static identity(): Transform3 {
    return IDENTITY;
  }

  /** A pure translation along the axes of the frame it is composed into. */
  public static translation(offset: Vector3): Transform3 {
    return new Transform3(IDENTITY_ROTATION, Point3.origin().add(offset));
  }

  /** A translation along z alone — the axial layout every centered system has. */
  public static axialShift(distance: number): Transform3 {
    return new Transform3(IDENTITY_ROTATION, new Point3(0, 0, distance));
  }

  /** Right-handed rotation about x, in radians. */
  public static rotationX(radians: number): Transform3 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return new Transform3([1, 0, 0, 0, c, -s, 0, s, c], Point3.origin());
  }

  /** Right-handed rotation about y, in radians. */
  public static rotationY(radians: number): Transform3 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return new Transform3([c, 0, s, 0, 1, 0, -s, 0, c], Point3.origin());
  }

  /** Right-handed rotation about z, in radians. */
  public static rotationZ(radians: number): Transform3 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return new Transform3([c, -s, 0, s, c, 0, 0, 0, 1], Point3.origin());
  }

  /**
   * `this ∘ inner`: the transform taking `inner`'s local frame all the way out
   * to whatever frame `this` is expressed in. Composing left to right down a
   * surface list therefore accumulates the chain of local frames.
   */
  public compose(inner: Transform3): Transform3 {
    const a = this.rotation;
    const b = inner.rotation;
    const rotation = new Array<number>(9);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        rotation[row * 3 + column] =
          a[row * 3]! * b[column]! +
          a[row * 3 + 1]! * b[3 + column]! +
          a[row * 3 + 2]! * b[6 + column]!;
      }
    }
    return new Transform3(rotation, this.apply(inner.origin));
  }

  /** Maps a point from the local frame into the enclosing one. */
  public apply(point: Point3): Point3 {
    const r = this.rotation;
    const { x, y, z } = point;
    return new Point3(
      r[0]! * x + r[1]! * y + r[2]! * z + this.origin.x,
      r[3]! * x + r[4]! * y + r[5]! * z + this.origin.y,
      r[6]! * x + r[7]! * y + r[8]! * z + this.origin.z,
    );
  }

  /** Maps a direction — rotation only, so lengths and unit-ness survive. */
  public applyDirection(vector: Vector3): Vector3 {
    const r = this.rotation;
    const { x, y, z } = vector;
    return new Vector3(
      r[0]! * x + r[1]! * y + r[2]! * z,
      r[3]! * x + r[4]! * y + r[5]! * z,
      r[6]! * x + r[7]! * y + r[8]! * z,
    );
  }

  /** Maps a point from the enclosing frame down into the local one. */
  public toLocal(point: Point3): Point3 {
    const r = this.rotation;
    const x = point.x - this.origin.x;
    const y = point.y - this.origin.y;
    const z = point.z - this.origin.z;
    // The rotation is orthonormal, so its inverse is its transpose.
    return new Point3(
      r[0]! * x + r[3]! * y + r[6]! * z,
      r[1]! * x + r[4]! * y + r[7]! * z,
      r[2]! * x + r[5]! * y + r[8]! * z,
    );
  }

  /** Maps a direction from the enclosing frame down into the local one. */
  public toLocalDirection(vector: Vector3): Vector3 {
    const r = this.rotation;
    const { x, y, z } = vector;
    return new Vector3(
      r[0]! * x + r[3]! * y + r[6]! * z,
      r[1]! * x + r[4]! * y + r[7]! * z,
      r[2]! * x + r[5]! * y + r[8]! * z,
    );
  }

  /** The local frame's z axis in enclosing coordinates — where the light goes next. */
  public get axis(): Vector3 {
    const r = this.rotation;
    return new Vector3(r[2]!, r[5]!, r[8]!);
  }

  /**
   * How far this frame is turned **about its own axis**, in radians, measured
   * against a frame that shares that axis and is turned by nothing else.
   *
   * This is what an aperture's *orientation* is. A surface aperture is stated in
   * the surface's own frame — `apertureBlocks` takes a local x and y — so
   * nothing in an aperture record says which way round it lies, and a
   * coordinate transform's z tilt is the only thing that can turn a rectangle,
   * an ellipse or a spider on its surface. LSST is the case that asks for it:
   * two of its baffles carry the identical record `SQOB 400 1600`, and they are
   * at right angles to each other because one sits after a +45° z tilt and the
   * other after a −45° one. Nothing but this number tells them apart.
   *
   * Defined as the **twist** of a swing–twist decomposition: turn global +z onto
   * this frame's axis by the shortest rotation there is — which by construction
   * adds no turn about that axis — and whatever turn is left over is this. Two
   * consequences worth knowing:
   *
   * - Where the transforms are z tilts alone, which is the ordinary case and
   *   every aperture the corpus rotates, it is simply their sum.
   * - A tilt about x or y contributes **nothing**, which is right: it turns the
   *   surface *out of* its plane rather than within it, and an icon drawn face
   *   on has no way to show that and should not pretend to.
   *
   * Zero for a frame facing exactly backwards along −z, where the shortest
   * rotation is any of infinitely many and a roll cannot be defined at all.
   */
  public get roll(): number {
    const r = this.rotation;
    // The local axes in global coordinates are the columns of the rotation.
    const ax = r[0]!;
    const ay = r[3]!;
    const az = r[6]!;
    const zx = r[2]!;
    const zy = r[5]!;
    const zz = r[8]!;

    // The shortest rotation carrying this frame's axis back onto global +z, as
    // an axis-angle: `k` is the axis (unnormalized), `cos` and `sin` the angle.
    const kx = zy;
    const ky = -zx;
    const sin = Math.hypot(kx, ky);
    const cos = zz;

    let x: number;
    let y: number;
    if (sin < ORTHOGONAL_TOLERANCE) {
      // Already along ±z. Facing forward there is nothing to undo; facing
      // backwards the shortest rotation is not unique, so there is no honest
      // answer and 0 is the one that invents least.
      if (cos < 0) {
        return 0;
      }
      x = ax;
      y = ay;
    } else {
      // Rodrigues, with the local +x axis as the vector being carried back.
      const ux = kx / sin;
      const uy = ky / sin;
      // `u` has no z component, which drops several terms of the cross product
      // and of `u (u · v)`.
      const dot = ux * ax + uy * ay;
      x = ax * cos + uy * az * sin + ux * dot * (1 - cos);
      y = ay * cos - ux * az * sin + uy * dot * (1 - cos);
    }
    // The result is perpendicular to global z by construction, so this is the
    // whole of the angle rather than a projection of it.
    return Math.atan2(y, x);
  }

  /**
   * True when this frame is the global one turned by nothing at all. Centered
   * systems stay this way the whole way down the surface list, which is what
   * lets the paraxial layer and the 2-D layout keep treating them as axial.
   */
  public get isAxial(): boolean {
    for (let i = 0; i < 9; i += 1) {
      if (Math.abs(this.rotation[i]! - IDENTITY_ROTATION[i]!) > ORTHOGONAL_TOLERANCE) {
        return false;
      }
    }
    return (
      Math.abs(this.origin.x) < ORTHOGONAL_TOLERANCE &&
      Math.abs(this.origin.y) < ORTHOGONAL_TOLERANCE
    );
  }
}

/** How far a rotation may drift from the identity and still count as axial. */
const ORTHOGONAL_TOLERANCE = 1e-12;

const IDENTITY_ROTATION: readonly number[] = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const IDENTITY = new Transform3(IDENTITY_ROTATION, Point3.origin());
