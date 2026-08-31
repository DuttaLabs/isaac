import { BufferGeometry, Float32BufferAttribute } from 'three';
import {
  apertureHalfExtents,
  isCircularAperture,
  isObscuration,
  surfaceProfileSag,
  type Surface,
  type SurfaceAperture,
} from '@isaac/optical-core';

/**
 * A surface drawn over the aperture that bounds it, as a triangulated patch.
 *
 * The lathe that draws every other surface is a *surface of revolution*, and
 * three of the shapes the model now allows are not one: a rectangular aperture,
 * an elliptical aperture, and a circular aperture decentered off the surface's
 * own axis. Revolving those anyway draws the right size in the wrong shape or
 * the wrong place — the quiet kind of wrong, since it still renders a solid and
 * still looks like an optic.
 *
 * So this replaces the lathe exactly where the lathe cannot answer. The
 * parameterization is polar **about the aperture's center**, which is what makes
 * one function cover all of them: for each angle, the aperture reaches some
 * boundary radius, and the material runs from its hole (if it has one) out to
 * that boundary. A circle's boundary is constant, a rectangle's is the nearer of
 * its two walls, an ellipse's is the ellipse.
 *
 * **The sag is always measured from the surface's own axis**, never from the
 * aperture's center. An off-axis parabola is a piece of the parent, and it
 * curves the way the parent does at that distance out — which is the whole
 * reason the piece is worth cutting.
 */
export function aperturePatch(
  surface: Surface,
  fallbackSemiDiameter: number,
  rings: number,
  segments: number,
): BufferGeometry {
  const aperture = surface.aperture;
  const extent = Number.isFinite(surface.semiDiameter)
    ? surface.semiDiameter
    : fallbackSemiDiameter;
  const half = apertureHalfExtents(aperture, extent) ?? { x: extent, y: extent };
  const centerX = aperture?.decenterX ?? 0;
  const centerY = aperture?.decenterY ?? 0;
  // Only a circular aperture has an inner radius; the file format gives the
  // rectangular and elliptical forms no equivalent.
  const inner = aperture !== undefined && aperture.kind === 'CIRCULAR' ? aperture.minRadius : 0;

  const positions: number[] = [];
  const indices: number[] = [];

  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    for (let segment = 0; segment <= segments; segment += 1) {
      const angle = (2 * Math.PI * segment) / segments;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const outer = boundaryRadius(aperture, half, cos, sin);
      const radius = inner + (outer - inner) * t;
      const x = centerX + radius * cos;
      const y = centerY + radius * sin;
      positions.push(x, y, surfaceProfileSag(surface.shape, Math.hypot(x, y)));
    }
  }

  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * stride + segment;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * How far the aperture reaches at one angle, measured from its own center.
 *
 * A rectangle reaches whichever of its two walls is nearer along that direction
 * — the `min` of the two — and an ellipse reaches its own boundary, which is the
 * radius that makes `(x/a)² + (y/b)² = 1`. Both degenerate to the circle when
 * their half-widths are equal, which is the check that says the formula is right.
 */
function boundaryRadius(
  aperture: SurfaceAperture | undefined,
  half: { x: number; y: number },
  cos: number,
  sin: number,
): number {
  if (aperture === undefined || isCircularAperture(aperture.kind)) {
    return half.x;
  }
  if (aperture.kind === 'RECTANGULAR' || aperture.kind === 'RECTANGULAR_OBSCURATION') {
    // The wall a ray at this angle meets first. A perfectly axial direction
    // meets only one of them, and dividing by its zero cosine would say the
    // other is infinitely far — true, and handled by the `min`.
    return Math.min(
      cos === 0 ? Infinity : Math.abs(half.x / cos),
      sin === 0 ? Infinity : Math.abs(half.y / sin),
    );
  }
  return 1 / Math.hypot(cos / half.x, sin / half.y);
}

/**
 * Whether this surface needs a patch rather than a lathe.
 *
 * A centered circle — including an annulus — is a surface of revolution, and the
 * lathe draws it better and with fewer triangles. Everything else is here.
 * An obscuration does not bound the surface at all, so it changes nothing about
 * the shape drawn and stays with the lathe.
 */
export function needsAperturePatch(surface: Surface): boolean {
  const aperture = surface.aperture;
  if (aperture === undefined || isObscuration(aperture.kind)) {
    return false;
  }
  return !isCircularAperture(aperture.kind) || aperture.decenterX !== 0 || aperture.decenterY !== 0;
}
