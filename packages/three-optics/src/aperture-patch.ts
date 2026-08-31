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
  return patchOver(surface, rings, segments, {
    centerX: aperture?.decenterX ?? 0,
    centerY: aperture?.decenterY ?? 0,
    // Only a circular aperture has an inner radius; the file format gives the
    // rectangular and elliptical forms no equivalent.
    inner: aperture !== undefined && aperture.kind === 'CIRCULAR' ? aperture.minRadius : 0,
    boundary: (cos, sin) => boundaryRadius(aperture, half, cos, sin),
  });
}

/** A ring of surface between two boundaries, in the surface's own frame. */
interface PatchRegion {
  centerX: number;
  centerY: number;
  inner: number;
  boundary: (cos: number, sin: number) => number;
}

/**
 * The triangulated patch itself: a grid in (angle, radius) laid on the surface.
 *
 * Taken apart from {@link aperturePatch} because an obscuration wants the very
 * same mesh over a different region — the disc it *blocks* rather than the one
 * it leaves open — and building that a second way is how the two would come to
 * disagree about where a decentered aperture sits.
 */
function patchOver(
  surface: Surface,
  rings: number,
  segments: number,
  region: PatchRegion,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    for (let segment = 0; segment <= segments; segment += 1) {
      const angle = (2 * Math.PI * segment) / segments;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const outer = region.boundary(cos, sin);
      const radius = region.inner + (outer - region.inner) * t;
      const x = region.centerX + radius * cos;
      const y = region.centerY + radius * sin;
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
 * The part of a surface an obscuration blocks, as geometry in its own right.
 *
 * Drawn at all because otherwise it is drawn *nowhere*: an obscuration does not
 * bound the surface, so the surface comes out at its full semi-diameter and the
 * thing standing in the beam is invisible. Seven of the twenty-two obscurations
 * in the sample corpus are smaller than the surface they sit on.
 *
 * `undefined` where there is nothing to draw, which is every surface without an
 * obscuring aperture.
 */
export function obscurationGeometry(
  surface: Surface,
  fallbackSemiDiameter: number,
  rings: number,
  segments: number,
): BufferGeometry | undefined {
  const aperture = surface.aperture;
  if (aperture === undefined || !isObscuration(aperture.kind)) {
    return undefined;
  }
  const extent = Number.isFinite(surface.semiDiameter)
    ? surface.semiDiameter
    : fallbackSemiDiameter;

  if (aperture.kind === 'SPIDER') {
    return spiderGeometry(surface, aperture, extent, segments);
  }
  const circular = aperture.kind === 'CIRCULAR_OBSCURATION';
  const half = circular
    ? { x: aperture.maxRadius, y: aperture.maxRadius }
    : { x: aperture.halfWidthX, y: aperture.halfWidthY };
  return patchOver(surface, rings, segments, {
    centerX: aperture.decenterX,
    centerY: aperture.decenterY,
    inner: circular ? aperture.minRadius : 0,
    boundary: (cos, sin) => boundaryRadius(aperture, half, cos, sin),
  });
}

/**
 * A spider's vanes: one strip per arm, running from the center out to the rim.
 *
 * Laid on the surface rather than drawn flat, so a vane across a curved mirror
 * follows it — the same reason every other patch here takes its sag from the
 * surface it belongs to.
 */
function spiderGeometry(
  surface: Surface,
  aperture: SurfaceAperture,
  extent: number,
  samples: number,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = aperture.armWidth / 2;
  const steps = Math.max(4, Math.floor(samples / 8));

  for (let arm = 0; arm < aperture.armCount; arm += 1) {
    // The first arm along +x, the rest spaced equally from it.
    const angle = (2 * Math.PI * arm) / aperture.armCount;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const base = positions.length / 3;
    for (let step = 0; step <= steps; step += 1) {
      const along = (extent * step) / steps;
      for (const across of [-half, half]) {
        const x = aperture.decenterX + along * cos - across * sin;
        const y = aperture.decenterY + along * sin + across * cos;
        positions.push(x, y, surfaceProfileSag(surface.shape, Math.hypot(x, y)));
      }
    }
    for (let step = 0; step < steps; step += 1) {
      const a = base + step * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
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
