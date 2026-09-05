import type { OpticalSystem } from '../model/optical-system.ts';
import type { Surface } from '../model/surface.ts';
import { apertureClearRadius } from '../model/aperture.ts';

/** Slopes below this are treated as parallel to the axis (afocal / telecentric). */
const PARAXIAL_EPSILON = 1e-14;

/**
 * Optical power of a surface, the φ in `n'u' = nu − yφ`.
 *
 * A refracting surface gets it from its *vertex* curvature and the media it
 * separates; a `PARAXIAL` surface is given it directly as φ = 1/f. Vertex
 * curvature, not the base radius: an even asphere's first coefficient is an r²
 * term, so it adds `2α₁` to the curvature a paraxial ray sees. The conic
 * constant, by contrast, never appears — every conic sharing a vertex curvature
 * has the same first-order behavior, which is precisely why a conic corrects
 * aberration without disturbing the layout. The focal length is read
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
  if (surface.type === 'COORDINATE_TRANSFORM') {
    // A coordinate transform has no shape and no glass boundary, so it has no power.
    // Its thickness still separates the surfaces around it, which the recurrence
    // picks up from the transfer step — the axis has been re-pointed, but the
    // distance measured along it is the same, which is why a folded system has
    // the focal length of its unfolded equivalent.
    return 0;
  }
  return (indexAfter - indexBefore) * surface.paraxialCurvature;
}

/**
 * Refractive index of the medium after each surface, **signed by the direction
 * the light is traveling**: positive while it runs −Z → +Z, negative after an
 * odd number of mirrors. Entry `i` is the medium between surface `i` and
 * surface `i + 1`, so entry 0 is object space.
 *
 * This one sign is what lets mirrors through the whole paraxial layer without a
 * single special case. A mirror is just a surface across which the index goes
 * from `n` to `−n`: its power falls out of the ordinary formula as
 * `(−n − n)c = −2nc`, and the transfer `y += u'·t` stays right because a
 * thickness after a mirror is *negative* — the distance to the next surface
 * measured along +Z, which is now behind the light. That is the same convention
 * `.zmx` files are written in and the same one `OpticalSystem` already
 * accumulates into vertex positions, so nothing about the axial layout changes.
 *
 * The magnitude after a reflection is carried over from before it rather than
 * read off the surface's own material: a mirror does not change the medium, and
 * `OpticalSystem` refuses one that claims to.
 */
export function signedMediaIndices(
  system: OpticalSystem,
  wavelengthNm: number = system.primaryWavelengthNm,
): number[] {
  const media = new Array<number>(system.surfaces.length);
  media[0] = system.objectSurface.material.indexAt(wavelengthNm);
  let sign = 1;
  for (let index = 1; index < system.surfaces.length; index += 1) {
    const surface = system.surfaceAt(index);
    if (surface.reflective) {
      sign = -sign;
      media[index] = sign * Math.abs(media[index - 1]!);
    } else {
      media[index] = sign * surface.material.indexAt(wavelengthNm);
    }
  }
  return media;
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
  /**
   * Effective focal length: `1/φ`, the focal length **referred to air**, which
   * is what OpticStudio's EFFL reports and what divides the entrance pupil to
   * give the F/#. It is *not* `−y₁/u′` unless the image space is air — see the
   * three focal lengths in {@link paraxialProperties}. `Infinity` for an afocal
   * system.
   */
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
  /**
   * Global z of the front (object-side) principal plane, `P`.
   *
   * The principal planes are the pair of conjugate planes at unit magnification,
   * and they are what a focal length is measured *from*: the front focal point
   * lies one EFL before `P`, the rear focal point one EFL after `P'`. That is
   * the whole content of the thin-lens formula applied to a thick system — the
   * lens behaves, to first order, exactly like a thin one placed at these
   * planes. They may lie inside the glass, outside it, or crossed over each
   * other, none of which is a fault.
   *
   * `NaN` for an afocal system, which has no focal length to measure and so no
   * planes to measure it from.
   */
  frontPrincipalPlaneZ: number;
  /** Global z of the rear (image-side) principal plane, `P'`. */
  rearPrincipalPlaneZ: number;
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
  const media = signedMediaIndices(system, wavelengthNm);
  let height = start.height;
  let angle = start.angle;

  for (let index = 1; index <= last; index += 1) {
    const surface = system.surfaceAt(index);
    const indexBefore = media[index - 1]!;
    const indexAfter = media[index]!;
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

  // Collimated ray in from the left: gives the focal lengths and the back focal
  // distance.
  const forward = paraxialTrace(system, { height: 1, angle: 0 }, wavelengthNm);
  const exit = forward[forward.length - 1]!;
  const afocal = exit.angleAfter === 0;
  const objectIndex = signedMediaIndices(system, wavelengthNm)[0]!;

  // **There are three focal lengths here and only one of them is the EFL.**
  //
  // `−y₁/u′` taken with the *real* exit slope is `n′/φ`, the **image-space**
  // focal length: the true geometric distance from the rear principal plane to
  // the rear focus. `n/φ` is its object-space counterpart. The **effective**
  // focal length is `1/φ` — the same length referred to air — and that is the
  // one everything means by "focal length": it is what divides the entrance
  // pupil to give the F/#, and what a designer quotes.
  //
  // All three coincide whenever the system sits in air, which is why this went
  // unnoticed until an immersion lithography objective arrived with **water**
  // between its last surface and the wafer. Isaac reported 5198.311 mm against
  // OpticStudio's 3895.847 — a ratio of 1.334321, water's index at 550 nm to
  // the last digit it prints.
  //
  // The index is taken by **magnitude**, which is what keeps the mirror
  // convention intact: `signedMediaIndices` turns the index negative after an
  // odd number of reflections, and that sign belongs to the focal length —
  // image space really does run backwards. A reflecting system in air has
  // `|n′| = 1`, so nothing about Hubble or the Gregorian moves.
  const imageSpaceFocalLength = afocal ? Infinity : -forward[0]!.height / exit.angleAfter;
  const effectiveFocalLength = afocal
    ? Infinity
    : imageSpaceFocalLength / Math.abs(exit.indexAfter);
  const objectSpaceFocalLength = afocal ? Infinity : effectiveFocalLength * Math.abs(objectIndex);
  const backFocalDistance = afocal ? Infinity : -exit.height / exit.angleAfter;

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
    const conjugate = paraxialTrace(system, { height: objectThickness, angle: 1 }, wavelengthNm);
    const conjugateExit = conjugate[conjugate.length - 1]!;
    imageDistance =
      conjugateExit.angleAfter === 0 ? Infinity : -conjugateExit.height / conjugateExit.angleAfter;
    magnification =
      conjugateExit.angleAfter === 0
        ? 0
        : (objectIndex * 1) / (conjugateExit.indexAfter * conjugateExit.angleAfter);
  }

  const lastVertexZ = system.axialPositionAt(last);
  // The focal points, less one focal length each: F' = P' + f' and F = P − f.
  // These are *positions on the axis*, so each takes the focal length measured
  // in the space it lives in — `n'/φ` behind and `n/φ` in front — and not the
  // air-equivalent EFL, which is a distance in no particular medium. In air the
  // three are the same number, which is why one served for both until now.
  // Both come out non-finite for an afocal system, which the callers test for
  // rather than being handed a plausible number.
  const rearPrincipalPlaneZ = lastVertexZ + backFocalDistance - imageSpaceFocalLength;
  const frontPrincipalPlaneZ =
    system.axialPositionAt(1) + frontFocalDistance + objectSpaceFocalLength;

  return {
    wavelengthNm,
    effectiveFocalLength,
    power: Number.isFinite(effectiveFocalLength) ? 1 / effectiveFocalLength : 0,
    backFocalDistance,
    frontFocalDistance,
    imageDistance,
    paraxialImageZ: lastVertexZ + imageDistance,
    frontPrincipalPlaneZ,
    rearPrincipalPlaneZ,
    imageSurfaceZ: system.axialPositionAt(system.surfaces.length - 1),
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
  return system.withSurfaceAt(
    last,
    system.surfaceAt(last).with({ thickness: properties.imageDistance }),
  );
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
  return solveEntrancePupil(system, wavelengthNm, requireStopRadius(system, requireStop(system)));
}

/**
 * Where the entrance pupil *is*, without asking how big it is.
 *
 * The two are solved by two rays, and only the second needs a stop radius: the
 * pupil's position comes from a ray leaving the stop's center, which starts on
 * the axis whatever the stop's size. Splitting them apart is what lets a system
 * whose stop has no stated size — an off-axis design whose stop is a bare plane,
 * with the pupil declared by `ENPD` instead — still be aimed and traced. Asking
 * for the radius of such a pupil is still an error, because that number is
 * genuinely not knowable from the stop.
 */
export function entrancePupilPlaneZ(
  system: OpticalSystem,
  wavelengthNm: number = system.primaryWavelengthNm,
): number {
  return solveEntrancePupil(system, wavelengthNm, 0).z;
}

function solveEntrancePupil(
  system: OpticalSystem,
  wavelengthNm: number,
  stopRadius: number,
): Pupil {
  const stopIndex = requireStop(system);

  // Two rays leaving the stop backwards, in the reversed frame ζ = −(z − z₁):
  // one from the center to locate the pupil, one from the rim to size it.
  const media = signedMediaIndices(system, wavelengthNm);
  let axial = { height: 0, slope: 1 };
  let edge = { height: stopRadius, slope: 0 };

  for (let index = stopIndex - 1; index >= 1; index -= 1) {
    const surface = system.surfaceAt(index);
    const gap = surface.thickness;
    axial = { height: axial.height + axial.slope * gap, slope: axial.slope };
    edge = { height: edge.height + edge.slope * gap, slope: edge.slope };

    // Reversed refraction: the media swap, and the power is direction-independent.
    // The media are the *signed* ones, which is all a mirror before the stop
    // needs: reversing the trace already flips every index, and the mirror's own
    // sign change survives that flip intact.
    const indexBefore = media[index]!;
    const indexAfter = media[index - 1]!;
    const power = surfacePower(surface, indexAfter, indexBefore);
    axial.slope = (indexBefore * axial.slope - axial.height * power) / indexAfter;
    edge.slope = (indexBefore * edge.slope - edge.height * power) / indexAfter;
  }

  if (Math.abs(axial.slope) < PARAXIAL_EPSILON) {
    throw new RangeError('The entrance pupil is at infinity (object-space telecentric).');
  }
  // Axis crossing in the reversed frame, converted back to a global z.
  const zeta = -axial.height / axial.slope;
  const z = system.axialPositionAt(1) - zeta;
  const heightAtPupil = edge.height + edge.slope * zeta;

  return {
    z,
    radius: Math.abs(heightAtPupil),
    magnification: heightAtPupil / stopRadius,
    stopIndex,
  };
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

  const media = signedMediaIndices(system, wavelengthNm);
  let axial = { height: 0, slope: 1 };
  let edge = { height: stopRadius, slope: 0 };

  for (let index = stopIndex + 1; index <= last; index += 1) {
    const surface = system.surfaceAt(index);
    const gap = system.surfaceAt(index - 1).thickness;
    axial = { height: axial.height + axial.slope * gap, slope: axial.slope };
    edge = { height: edge.height + edge.slope * gap, slope: edge.slope };

    const indexBefore = media[index - 1]!;
    const indexAfter = media[index]!;
    const power = surfacePower(surface, indexBefore, indexAfter);
    axial.slope = (indexBefore * axial.slope - axial.height * power) / indexAfter;
    edge.slope = (indexBefore * edge.slope - edge.height * power) / indexAfter;
  }

  if (Math.abs(axial.slope) < PARAXIAL_EPSILON) {
    throw new RangeError('The exit pupil is at infinity (image-space telecentric).');
  }
  const reference =
    stopIndex >= last ? system.axialPositionAt(stopIndex) : system.axialPositionAt(last);
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

/**
 * How big the stop is: its aperture if it has one, and its drawn extent if not.
 *
 * The aperture comes first because that is what actually stops light — a stop
 * whose `CLAP` says 25 mm is a 25 mm stop however large the surface is drawn.
 * The semi-diameter is the fallback for the common case of a stop with no
 * aperture record at all, where the file is using the drawn size to mean the
 * hole.
 */
export function stopRadius(system: OpticalSystem, stopIndex: number): number {
  const surface = system.surfaceAt(stopIndex);
  const limit = apertureClearRadius(surface.aperture, surface.semiDiameter);
  // `apertureClearRadius` answers "what is the largest circle this aperture
  // passes", so a surface with no aperture answers Infinity — true, and not what
  // a stop's size is. The drawn extent is the fallback there.
  return Number.isFinite(limit) ? limit : surface.semiDiameter;
}

function requireStopRadius(system: OpticalSystem, stopIndex: number): number {
  const radius = stopRadius(system, stopIndex);
  if (!Number.isFinite(radius)) {
    throw new RangeError(
      'The aperture stop has neither an aperture nor a finite semi-diameter, so there is nothing to size the pupils from.',
    );
  }
  return radius;
}

/** Index of the last surface that refracts: the one immediately before IMAGE. */
export function lastRefractingSurfaceIndex(system: OpticalSystem): number {
  return system.surfaces.length - 2;
}

/**
 * Front focal distance, from a paraxial trace run backwards through the system.
 * Reversing swaps each surface's neighboring media and flips its curvature, so
 * the same recurrence applies with the surface order inverted.
 */
function computeFrontFocalDistance(system: OpticalSystem, wavelengthNm: number): number {
  const last = lastRefractingSurfaceIndex(system);
  const media = signedMediaIndices(system, wavelengthNm);
  let height = 1;
  let angle = 0;

  for (let index = last; index >= 1; index -= 1) {
    const surface = system.surfaceAt(index);
    // Traveling backwards: the medium after the surface is the one we come from.
    const indexBefore = media[index]!;
    const indexAfter = media[index - 1]!;
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
