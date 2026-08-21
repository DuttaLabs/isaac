/**
 * The shape of a rotationally symmetric surface, and the sag that defines it.
 *
 * Everything here is in the surface's **local frame**: the vertex is at the
 * origin and the axis is +Z, so the surface is the set of points whose axial
 * coordinate is the sag at their radial height,
 *
 *     z(r) = c·r² / (1 + √(1 − (1 + k)·c²·r²)) + Σ αᵢ·r^(2i)
 *
 * with `c` the vertex curvature, `k` the conic constant, and `αᵢ` the aspheric
 * coefficients on r², r⁴, … This is Zemax's even-asphere sag; dropping the
 * polynomial leaves its standard surface, which is why a conic needs no separate
 * surface type here any more than it does there.
 *
 * The conic constant names a shape: 0 is a sphere, −1 a paraboloid, less than
 * −1 a hyperboloid, between −1 and 0 a prolate ellipsoid, and greater than 0 an
 * oblate ellipsoid. It is `−ε²` for an ellipse of eccentricity ε.
 *
 * This is the single definition of surface shape in the project. The tracer
 * intersects it, the paraxial recurrence takes its vertex curvature from it, and
 * both layout views draw its profile — so a surface cannot be drawn as one shape
 * and traced as another.
 */

/** How far the radical may fall below zero before a radius counts as off-surface. */
const RADICAL_TOLERANCE = 1e-12;

/** A rotationally symmetric surface profile, independent of where it sits. */
export interface SurfaceShape {
  /** Vertex curvature, 1 / radius; 0 for a plane. */
  curvature: number;
  /** Conic constant `k`; 0 for a sphere. */
  conic: number;
  /** `α₁…αₙ`, the coefficients on r², r⁴, … r^(2n). Empty for a plain conic. */
  asphericCoefficients: readonly number[];
}

/** The shape of a plain sphere or plane. */
export function sphericalShape(curvature: number): SurfaceShape {
  return { curvature, conic: 0, asphericCoefficients: [] };
}

/**
 * Largest radial height at which the conic base exists.
 *
 * A conic with `(1 + k)·c² > 0` closes on itself: past `r = 1/(|c|·√(1+k))` the
 * square root in the sag goes imaginary and there is simply no surface. For a
 * sphere that limit is the equator, `|R|`. Paraboloids, hyperboloids and planes
 * have no limit and return `Infinity`.
 */
export function maximumSagRadius(shape: SurfaceShape): number {
  const closing = (1 + shape.conic) * shape.curvature * shape.curvature;
  return closing > 0 ? 1 / Math.sqrt(closing) : Infinity;
}

/**
 * Axial sag at radial height `r`, or `null` where the surface does not exist.
 *
 * `null` is the honest answer past {@link maximumSagRadius}: the conic has
 * turned back on itself and nothing is there to intersect. Callers that draw
 * rather than trace want {@link surfaceProfileSag}, which holds at the rim.
 */
export function surfaceSag(shape: SurfaceShape, r: number): number | null {
  const radical = 1 - (1 + shape.conic) * shape.curvature * shape.curvature * r * r;
  if (radical < 0) {
    // The radical is dimensionless, so a fixed tolerance is meaningful here: a
    // ray landing exactly on the rim of a closing conic rounds either side of
    // zero, and refusing it would put a hole in the surface at its widest point.
    if (radical < -RADICAL_TOLERANCE) {
      return null;
    }
    return sagFrom(shape, r, 0);
  }
  return sagFrom(shape, r, radical);
}

/** The sag proper, once the radical is known to be usable. */
function sagFrom(shape: SurfaceShape, r: number, radical: number): number {
  const rSquared = r * r;
  let sag = shape.curvature === 0 ? 0 : (shape.curvature * rSquared) / (1 + Math.sqrt(radical));
  let power = rSquared;
  for (const coefficient of shape.asphericCoefficients) {
    sag += coefficient * power;
    power *= rSquared;
  }
  return sag;
}

/**
 * Sag for drawing a profile: like {@link surfaceSag}, but a radius past the
 * surface's limit is held at the limit rather than refused.
 *
 * A hemisphere drawn out to an aperture wider than itself is a picture of a
 * design fault, and showing it flattening at the equator says so; returning
 * nothing would leave a hole in the outline instead.
 */
export function surfaceProfileSag(shape: SurfaceShape, r: number): number {
  const limit = maximumSagRadius(shape);
  const clamped = Math.min(Math.abs(r), limit);
  // Clamped to the limit, the radical is zero or positive, so the sag exists.
  return surfaceSag(shape, clamped) ?? 0;
}

/**
 * `(dz/dr) / r` at radial height `r`, or `null` where the surface does not exist.
 *
 * Divided through by `r` because that is the form the surface normal wants —
 * the normal is `(−x·q, −y·q, 1)` up to orientation — and because it stays
 * finite on the axis, where `dz/dr` and `r` both vanish. Its axial value,
 * `c + 2α₁`, is the vertex curvature the paraxial recurrence uses.
 */
export function surfaceSlopeOverRadius(shape: SurfaceShape, r: number): number | null {
  const radical = 1 - (1 + shape.conic) * shape.curvature * shape.curvature * r * r;
  if (radical <= 0) {
    // At the rim of a closing conic the surface is parallel to the axis, so the
    // slope is infinite and there is no usable normal. A plane never gets here:
    // its radical is 1 at every radius.
    return null;
  }
  let slope = shape.curvature / Math.sqrt(radical);
  const rSquared = r * r;
  let power = 1;
  for (let index = 0; index < shape.asphericCoefficients.length; index += 1) {
    slope += 2 * (index + 1) * shape.asphericCoefficients[index]! * power;
    power *= rSquared;
  }
  return slope;
}

/**
 * Curvature the surface presents to a paraxial ray: `c + 2α₁`.
 *
 * The conic constant does not appear, because every conic of a given vertex
 * curvature has the same second-order shape — that is what makes a conic a
 * pure aberration correction, changing nothing about first-order layout. The
 * **first aspheric coefficient does** appear: `α₁·r²` is a second-order term
 * like the base sphere's own, so it shifts the vertex curvature and with it the
 * surface's power. Two of the sixteen even-asphere surfaces in OpticStudio's
 * sample files carry a non-zero α₁, so this is not a theoretical case; reading
 * the power off `curvature` alone would quietly mis-report their focal length.
 */
export function vertexCurvature(shape: SurfaceShape): number {
  return shape.curvature + 2 * (shape.asphericCoefficients[0] ?? 0);
}
