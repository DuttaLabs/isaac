/**
 * An immutable direction or displacement in a right-handed Cartesian space.
 *
 * This is deliberately independent of Three.js (or any other library) so that
 * `optical-core` stays portable to Web Workers, WebAssembly, Node.js, and a
 * future cloud service. UI layers convert to their own vector types at the edge.
 */
export class Vector3 {
  public readonly x: number;
  public readonly y: number;
  public readonly z: number;

  public constructor(x: number, y: number, z: number) {
    assertFinite(x, 'x');
    assertFinite(y, 'y');
    assertFinite(z, 'z');
    this.x = x;
    this.y = y;
    this.z = z;
  }

  public static zero(): Vector3 {
    return new Vector3(0, 0, 0);
  }

  /** The unit vector along +Z, i.e. the optical axis. */
  public static unitZ(): Vector3 {
    return new Vector3(0, 0, 1);
  }

  public add(other: Vector3): Vector3 {
    return new Vector3(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  public subtract(other: Vector3): Vector3 {
    return new Vector3(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  public scale(scalar: number): Vector3 {
    assertFinite(scalar, 'scalar');
    return new Vector3(this.x * scalar, this.y * scalar, this.z * scalar);
  }

  public negate(): Vector3 {
    return this.scale(-1);
  }

  public dot(other: Vector3): number {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  public cross(other: Vector3): Vector3 {
    return new Vector3(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x,
    );
  }

  public get lengthSquared(): number {
    return this.dot(this);
  }

  public get length(): number {
    return Math.sqrt(this.lengthSquared);
  }

  /** Returns a unit vector in the same direction. Throws for a zero vector. */
  public normalized(): Vector3 {
    const length = this.length;
    if (length === 0) {
      throw new RangeError('Cannot normalize a zero-length vector.');
    }
    return this.scale(1 / length);
  }

  public equals(other: Vector3, tolerance = 1e-12): boolean {
    assertTolerance(tolerance);
    return (
      Math.abs(this.x - other.x) <= tolerance &&
      Math.abs(this.y - other.y) <= tolerance &&
      Math.abs(this.z - other.z) <= tolerance
    );
  }

  public toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
}

function assertTolerance(tolerance: number): void {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('tolerance must be a finite, non-negative number.');
  }
}
