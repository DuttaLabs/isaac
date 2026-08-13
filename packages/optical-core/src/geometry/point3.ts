import { Vector3 } from './vector3.ts';

/**
 * An immutable position in the optical system's right-handed coordinate space.
 * Lengths are in the system's linear units (millimetres by convention).
 */
export class Point3 {
  public readonly x: number;
  public readonly y: number;
  public readonly z: number;

  public constructor(x: number, y: number, z: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new TypeError('Point coordinates must be finite numbers.');
    }
    this.x = x;
    this.y = y;
    this.z = z;
  }

  public static origin(): Point3 {
    return new Point3(0, 0, 0);
  }

  /** Translates this point by a displacement vector. */
  public add(vector: Vector3): Point3 {
    return new Point3(this.x + vector.x, this.y + vector.y, this.z + vector.z);
  }

  /** Returns the displacement vector from `other` to this point. */
  public subtract(other: Point3): Vector3 {
    return new Vector3(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  /** Position vector of this point relative to the origin. */
  public toVector(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  public distanceTo(other: Point3): number {
    return this.subtract(other).length;
  }

  public equals(other: Point3, tolerance = 1e-12): boolean {
    return this.subtract(other).equals(Vector3.zero(), tolerance);
  }

  public toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }
}
