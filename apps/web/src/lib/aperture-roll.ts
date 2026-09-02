import type { OpticalSystem } from '@isaac/optical-core';

/**
 * How far a surface's aperture is turned on its own surface, in degrees.
 *
 * An aperture record says nothing about which way round it lies: a rectangle,
 * an ellipse and a spider are all stated in the surface's *own* frame, so the
 * only thing that can turn one is a coordinate transform's z tilt earlier in
 * the prescription. `Transform3.roll` is that cumulative turn, and this is the
 * guarded way to ask a system for it.
 *
 * Positive is counter-clockwise, the model's own sense, looking back down the
 * axis at the surface. A drawing whose y grows *downward* — which is every SVG
 * — has to negate it.
 *
 * Zero where there is no pose to read: the OBJECT surface at an infinite
 * conjugate has a direction but no frame, and `poseAt` refuses it rather than
 * inventing one.
 */
export function apertureRollDegrees(system: OpticalSystem, index: number): number {
  if (index < 0 || index >= system.surfaces.length || !Number.isFinite(system.vertexZAt(index))) {
    return 0;
  }
  return (system.poseAt(index).roll * 180) / Math.PI;
}
