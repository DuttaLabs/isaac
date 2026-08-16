import type { OpticalSystem } from '../model/optical-system.ts';
import type { Surface } from '../model/surface.ts';

/** Slopes below this are treated as parallel to the axis (afocal / telecentric). */
const PARAXIAL_EPSILON = 1e-14;

/**
 * Optical power of a surface, the φ in `n'u' = nu − yφ`.
 *
 * A refracting surface gets it from its curvature and the media it separates; a
 * `PARAXIAL` surface is given it directly as φ = 1/f. The focal length is read
 * as the reciprocal of the power, so a paraxial surface between media of unequal
 * index focuses at `n'·f` rather than `f` — the two readings agree whenever the
 * surface sits in air, which is how ideal-lens placeholders are almost always used.
 *
 * Power is unchanged by reversing the system: swapping the media and flipping
 * the curvature leaves `(n' − n)c` alone, and a thin lens has the same power
 * either way round. Pass the media in *forward* order even when tracing
 * backwards.
 */
export function surfacePower(surface: Surface, indexBefore: number, indexAfter: number): number {
  if (surface.type === 'PARAXIAL') {
    return 1 / surface.focalLength!;
  }
  return (indexAfter - indexBefore) * surface.curvature;
}

/**
 * State of a paraxial ray at one surface. Angles are paraxial slopes (dy/dz),
 * not true angles; in the paraxial limit the two agree.
 */
export interface ParaxialRayState {
  surfaceIndex: number;
  /** Ray height at the surface. */
  height: number;
  /** Slope arriving at the surface. */
  angleBefore: number;
  /** Slope leaving the surface. */
  angleAfter: number;
  indexBefore: number;
  indexAfter: number;
  /** Surface power (n' − n)·c. */
  power: number;
}

/** Height and slope of a paraxial ray *at the first surface after the object*. */
export interface ParaxialStart {
  height: number;
  angle: number;
}

export interface ParaxialProperties {
  wavelengthNm: number;
  /** Effective focal length; `Infinity` for an afocal system. */
  effectiveFocalLength: number;
  /** System power, 1/EFL; zero for an afocal system. */
  power: number;
  /** Back focal distance: last surface vertex → rear focal point, for collimated input. */
  backFocalDistance: number;
  /** Front focal distance: first surface vertex → front focal point (negative when in front). */
  frontFocalDistance: number;
  /** Last surface vertex → paraxial image of the *actual* object conjugate. */
  imageDistance: number;
  /** Global z of the paraxial image plane. */
  paraxialImageZ: number;
  /** Global z of the currently defined IMAGE surface. */
  imageSurfaceZ: number;
  /** Paraxial (transverse) magnification; 0 for an object at infinity. */
  magnification: number;
  /** Index of the last surface that refracts, i.e. the one before IMAGE. */
  lastRefractingSurface: number;
}

/**
 * Traces a paraxial ray through the refracting surfaces of a system.
 *
 * The start is given at surface 1 (the first surface after the object), so
 * callers control the conjugate: `{ height: 1, angle: 0 }` is a collimated ray
 * from an object at infinity. The IMAGE surface does not refract and is not
 * included in the returned states.
 */
export function paraxialTrace(
  system: OpticalSystem,
  start: ParaxialStart,
  wavelengthNm: number = system.primaryWavelengthNm,
): ParaxialRayState[] {
  if (!Number.isFinite(start.height) || !Number.isFinite(start.angle)) {
    throw new TypeError('Paraxial start height and angle must be finite numbers.');
  }

  const states: ParaxialRayState[] = [];
  const last = lastRefractingSurfaceIndex(system);
  let height = start.height;
  let angle = start.angle;

  for (let index = 1; index <= last; index += 1) {
    const surface = system.surfaceAt(index);
    requireNoMirror(surface.reflective);
    const indexBefore = system.surfaceAt(index - 1).material.indexAt(wavelengthNm);
    const indexAfter = surface.material.indexAt(wavelengthNm);
    const power = surfacePower(surface, indexBefore, indexAfter);

    // Paraxial refraction: n'u' = nu − yφ.
    const angleAfter = (indexBefore * angle - height * power) / indexAfter;
    states.push({
      surfaceIndex: index,
      height,
      angleBefore: angle,
      angleAfter,
      indexBefore,
      indexAfter,
      power,
    });

    // Transfer to the next surface.
    angle = angleAfter;
    if (index < last) {
      height += angle * surface.thickness;
    }
  }

  return states;
}

/**
 * First-order properties of a system at one wavelength, from paraxial traces of
 * a collimated ray (focal lengths) and of the actual object conjugate (image
 * distance and magnification).
 */
export function paraxialProperties(
  system: OpticalSystem,
  wavelengthNm: number = system.primaryWavelengthNm,
): ParaxialProperties {
  const last = lastRefractingSurfaceIndex(system);
  if (last < 1) {
    throw new RangeError('A system needs at least one refracting surface for paraxial analysis.');
  }

  // Collimated ray in from the left: gives EFL and the back focal distance.
  const forward = paraxialTrace(system, { height: 1, angle: 0 }, wavelengthNm);
  const exit = forward[forward.length - 1]!;
  const effectiveFocalLength = exit.angleAfter === 0 ? Infinity : -forward[0]!.height / exit.angleAfter;
  const backFocalDistance = exit.angleAfter === 0 ? Infinity : -exit.height / exit.angleAfter;

  // Collimated ray in from the right (reversed system): gives the front focal distance.
  const frontFocalDistance = computeFrontFocalDistance(system, wavelengthNm);

  const objectThickness = system.objectSurface.thickness;
  let imageDistance: number;
  let magnification: number;
  if (!Number.isFinite(objectThickness)) {
    imageDistance = backFocalDistance;
    magnification = 0;
  } else {
    // Marginal ray from the axial object point: y = 0 at the object, unit slope.
    const objectIndex = system.objectSurface.material.indexAt(wavelengthNm);
    const conjugate = paraxialTrace(
      system,
      { height: objectThickness, angle: 1 },
      wavelengthNm,
    );
    const conjugateExit = conjugate[conjugate.length - 1]!;
    imageDistance = conjugateExit.angleAfter === 0 ? Infinity : -conjugateExit.height / conjugateExit.angleAfter;
    magnification =
      conjugateExit.angleAfter === 0
        ? 0
        : (objectIndex * 1) / (conjugateExit.indexAfter * conjugateExit.angleAfter);
  }

  const lastVertexZ = system.vertexZAt(last);
  return {
    wavelengthNm,
    effectiveFocalLength,
    power: Number.isFinite(effectiveFocalLength) ? 1 / effectiveFocalLength : 0,
    backFocalDistance,
    frontFocalDistance,
    imageDistance,
    paraxialImageZ: lastVertexZ + imageDistance,
    imageSurfaceZ: system.vertexZAt(system.surfaces.length - 1),
    magnification,
    lastRefractingSurface: last,
  };
}

/**
 * Returns a copy of the system whose IMAGE surface sits at the paraxial focus of
 * the current object conjugate — the equivalent of a marginal ray height solve
 * on the last thickness.
 */
export function withImageAtParaxialFocus(
  system: OpticalSystem,
  wavelengthNm: number = system.primaryWavelengthNm,
): OpticalSystem {
  const properties = paraxialProperties(system, wavelengthNm);
  if (!Number.isFinite(properties.imageDistance)) {
    throw new RangeError('An afocal system has no paraxial image plane to solve for.');
  }
  const last = properties.lastRefractingSurface;
  return system.withSurfaceAt(last, system.surfaceAt(last).with({ thickness: properties.imageDistance }));
}

/** A paraxial image of the aperture stop: where it appears, and how big. */
export interface Pupil {
  /** Global z of the pupil plane. */
  z: number;
  /** Pupil semi-diameter in system units. */
  radius: number;
  /** Paraxial magnification from the stop to this pupil (negative when inverted). */
  magnification: number;
  /** Index of the stop surface this pupil images. */
  stopIndex: number;
}

/**
 * The entrance pupil: the paraxial image of the stop formed by the surfaces
 * *before* it, as seen from object space. Ray aiming targets this plane.
 */
export function entrancePupil(
  system: OpticalSystem,
  wavelengthNm: number = system.primaryWavelengthNm,
): Pupil {
  const stopIndex = requireStop(system);
  const stopRadius = requireStopRadius(system, stopIndex);

  // Two rays leaving the stop backwards, in the reversed frame ζ = −(z − z₁):
  // one from the centre to locate the pupil, one from the rim to size it.
  let axial = { height: 0, slope: 1 };
  let edge = { height: stopRadius, slope: 0 };

  for (let index = stopIndex - 1; index >= 1; index -= 1) {
    const surface = system.surfaceAt(index);
    requireNoMirror(surface.reflective);
    const gap = surface.thickness;
    axial = { height: axial.height + axial.slope * gap, slope: axial.slope };
    edge = { height: edge.height + edge.slope * gap, slope: edge.slope };

    // Reversed refraction: the media swap, and the power is direction-independent.
    const indexBefore = surface.material.indexAt(wavelengthNm);
    const indexAfter = system.surfaceAt(index - 1).material.indexAt(wavelengthNm);
    const power = surfacePower(surface, indexAfter, indexBefore);
    axial.slope = (indexBefore * axial.slope - axial.height * power) / indexAfter;
    edge.slope = (indexBefore * edge.slope - edge.height * power) / indexAfter;
  }

  if (Math.abs(axial.slope) < PARAXIAL_EPSILON) {
    throw new RangeError('The entrance pupil is at infinity (object-space telecentric).');
  }
  // Axis crossing in the reversed frame, converted back to a global z.
  const zeta = -axial.height / axial.slope;
  const z = system.vertexZAt(1) - zeta;
  const heightAtPupil = edge.height + edge.slope * zeta;

  return { z, radius: Math.abs(heightAtPupil), magnification: heightAtPupil / stopRadius, stopIndex };
}

/**
 * The exit pupil: the paraxial image of the stop formed by the surfaces *after*
 * it, as seen from image space.
 */
export function exitPupil(
  system: OpticalSystem,
  wavelengthNm: number = system.primaryWavelengthNm,
): Pupil {
  const stopIndex = requireStop(system);
  const stopRadius = requireStopRadius(system, stopIndex);
  const last = lastRefractingSurfaceIndex(system);

  let axial = { height: 0, slope: 1 };
  let edge = { height: stopRadius, slope: 0 };

  for (let index = stopIndex + 1; index <= last; index += 1) {
    const surface = system.surfaceAt(index);
    requireNoMirror(surface.reflective);
    const gap = system.surfaceAt(index - 1).thickness;
    axial = { height: axial.height + axial.slope * gap, slope: axial.slope };
    edge = { height: edge.height + edge.slope * gap, slope: edge.slope };

    const indexBefore = system.surfaceAt(index - 1).material.indexAt(wavelengthNm);
    const indexAfter = surface.material.indexAt(wavelengthNm);
    const power = surfacePower(surface, indexBefore, indexAfter);
    axial.slope = (indexBefore * axial.slope - axial.height * power) / indexAfter;
    edge.slope = (indexBefore * edge.slope - edge.height * power) / indexAfter;
  }

  if (Math.abs(axial.slope) < PARAXIAL_EPSILON) {
    throw new RangeError('The exit pupil is at infinity (image-space telecentric).');
  }
  const reference = stopIndex >= last ? system.vertexZAt(stopIndex) : system.vertexZAt(last);
  const offset = -axial.height / axial.slope;
  const heightAtPupil = edge.height + edge.slope * offset;

  return {
    z: reference + offset,
    radius: Math.abs(heightAtPupil),
    magnification: heightAtPupil / stopRadius,
    stopIndex,
  };
}

function requireStop(system: OpticalSystem): number {
  const stopIndex = system.stopIndex;
  if (stopIndex === undefined) {
    throw new RangeError('The system has no surface marked as the aperture stop.');
  }
  return stopIndex;
}

function requireStopRadius(system: OpticalSystem, stopIndex: number): number {
  const radius = system.surfaceAt(stopIndex).semiDiameter;
  if (!Number.isFinite(radius)) {
    throw new RangeError('The aperture stop needs a finite semi-diameter to size the pupils.');
  }
  return radius;
}

function requireNoMirror(reflective: boolean): void {
  if (reflective) {
    throw new RangeError(
      'Paraxial analysis does not support mirrors yet; the axial layout assumes forward propagation.',
    );
  }
}

/** Index of the last surface that refracts: the one immediately before IMAGE. */
export function lastRefractingSurfaceIndex(system: OpticalSystem): number {
  return system.surfaces.length - 2;
}

/**
 * Front focal distance, from a paraxial trace run backwards through the system.
 * Reversing swaps each surface's neighbouring media and flips its curvature, so
 * the same recurrence applies with the surface order inverted.
 */
function computeFrontFocalDistance(system: OpticalSystem, wavelengthNm: number): number {
  const last = lastRefractingSurfaceIndex(system);
  let height = 1;
  let angle = 0;

  for (let index = last; index >= 1; index -= 1) {
    const surface = system.surfaceAt(index);
    // Travelling backwards: the medium after the surface is the one we come from.
    const indexBefore = surface.material.indexAt(wavelengthNm);
    const indexAfter = system.surfaceAt(index - 1).material.indexAt(wavelengthNm);
    const power = surfacePower(surface, indexAfter, indexBefore);

    angle = (indexBefore * angle - height * power) / indexAfter;
    if (index > 1) {
      height += angle * system.surfaceAt(index - 1).thickness;
    }
  }

  if (angle === 0) {
    return Infinity;
  }
  // Distance is measured back toward −Z from surface 1's vertex.
  return height / angle;
}
