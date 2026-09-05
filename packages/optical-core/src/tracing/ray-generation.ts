import { Point3 } from '../geometry/point3.ts';
import { Vector3 } from '../geometry/vector3.ts';
import type { Field, OpticalSystem } from '../model/optical-system.ts';
import { Ray } from '../model/ray.ts';
import {
  entrancePupil,
  entrancePupilPlaneZ,
  paraxialProperties,
  paraxialTrace,
} from './paraxial.ts';
import { traceRay, type RayTraceResult } from './trace.ts';

/**
 * A point in the entrance pupil in normalized coordinates: (0, 0) is the pupil
 * center and the unit circle px² + py² = 1 is its rim. Values outside the unit
 * circle are allowed so callers can deliberately probe beyond the pupil.
 */
export interface PupilPoint {
  px: number;
  py: number;
}

export interface RayGenerationOptions {
  /** Field to launch from: an index into `system.fields`, or an explicit field. Defaults to on-axis. */
  field?: number | Field;
  /** Wavelength in nanometers. Defaults to the system's primary wavelength. */
  wavelengthNm?: number;
  /**
   * Axial position of the launch plane, used only for objects at infinity.
   * Defaults to a plane just in front of the first surface.
   */
  startZ?: number;
  /** Relative intensity assigned to the generated rays. Defaults to 1. */
  intensity?: number;
}

export interface RayFanOptions extends RayGenerationOptions {
  /** Number of rays across the pupil diameter. Defaults to 11. */
  count?: number;
  /** Pupil axis the fan runs along. Defaults to 'y' (the meridional fan). */
  axis?: 'x' | 'y';
}

export interface PupilGridOptions extends RayGenerationOptions {
  /** Number of samples across the pupil diameter in each direction. Defaults to 11. */
  count?: number;
}

const EPSILON = 1e-12;

/**
 * Radius of the entrance pupil in system units, from the system's aperture
 * definition. `FLOAT_BY_STOP` (and an undefined aperture) take the size from a
 * paraxial image of the stop; see {@link entrancePupil}.
 */
export function entrancePupilRadius(system: OpticalSystem): number {
  const aperture = system.aperture;
  if (!aperture) {
    // With no aperture definition the stop itself sets the pupil, if there is one.
    if (system.stopIndex !== undefined) {
      return entrancePupil(system).radius;
    }
    throw new RangeError('The system has no aperture definition; cannot size the entrance pupil.');
  }
  if (aperture.type === 'FLOAT_BY_STOP') {
    return entrancePupil(system).radius;
  }

  const value = aperture.value;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Aperture type ${aperture.type} needs a positive, finite value.`);
  }

  switch (aperture.type) {
    case 'ENTRANCE_PUPIL_DIAMETER':
      return value / 2;

    case 'OBJECT_SPACE_NA': {
      if (!Number.isFinite(objectDistance(system))) {
        throw new RangeError('OBJECT_SPACE_NA requires an object at a finite distance.');
      }
      const indexBefore = system.objectSurface.material.indexAt(system.primaryWavelengthNm);
      const sine = value / indexBefore;
      if (sine >= 1) {
        throw new RangeError(`Object-space NA ${value} is not physical in index ${indexBefore}.`);
      }
      // **The cone is measured to the entrance pupil, not to the first surface.**
      // The numerical aperture is the sine of the marginal ray angle *at the
      // object*, and that ray ends on the rim of the entrance pupil — which is
      // where every other aperture type here is measured, and where
      // `generateRay` aims. The two coincide only when the pupil happens to lie
      // at surface 1, which is why measuring to surface 1 survived: it is right
      // in the simple case and wrong by the distance between them otherwise. On
      // `Liang2006c.zmx` the pupil sits 59.3 mm past a surface 0.15 mm from the
      // object, so the pupil came out **396 times too small** and every traced
      // ray was near-axial.
      return pupilDistanceFromObject(system) * Math.tan(Math.asin(sine));
    }

    case 'IMAGE_SPACE_FNUM': {
      if (!isObjectAtInfinity(system)) {
        throw new RangeError(
          'IMAGE_SPACE_FNUM is defined for an object at infinity; use the working F/# or an explicit pupil for finite conjugates.',
        );
      }
      const efl = paraxialProperties(system).effectiveFocalLength;
      if (!Number.isFinite(efl)) {
        throw new RangeError('An afocal system has no image-space F/#.');
      }
      return Math.abs(efl) / (2 * value);
    }

    default:
      throw new RangeError(`Unsupported aperture type ${aperture.type}.`);
  }
}

/**
 * Axial position of the plane rays are aimed at: the paraxial entrance pupil
 * when a stop is defined, otherwise the vertex plane of the first surface.
 */
export function entrancePupilZ(system: OpticalSystem): number {
  // The *plane*, not the pupil: aiming needs to know where to point, and a
  // system can perfectly well declare its pupil size with `ENPD` while its stop
  // is a bare plane with no size of its own. Asking for the whole pupil here
  // would refuse to trace such a system over a number it never needed.
  return system.stopIndex === undefined ? system.axialPositionAt(1) : entrancePupilPlaneZ(system);
}

/**
 * Image-space F/# for the current aperture: EFL / entrance pupil diameter.
 * Only meaningful for an object at infinity.
 */
export function imageSpaceFNumber(
  system: OpticalSystem,
  wavelengthNm: number = system.primaryWavelengthNm,
): number {
  const efl = paraxialProperties(system, wavelengthNm).effectiveFocalLength;
  if (!Number.isFinite(efl)) {
    throw new RangeError('An afocal system has no image-space F/#.');
  }
  return Math.abs(efl) / (2 * entrancePupilRadius(system));
}

/** Axial distance from the object surface to the first surface (Infinity for an object at infinity). */
export function objectDistance(system: OpticalSystem): number {
  return system.objectSurface.thickness;
}

/**
 * Object plane to entrance-pupil plane, which is the lever arm an object-space
 * angle turns into a pupil height. Falls back to the first surface when there is
 * no stop to image, since then there is no pupil to solve for and surface 1 is
 * the only plane on offer.
 */
function pupilDistanceFromObject(system: OpticalSystem): number {
  if (system.stopIndex === undefined) return objectDistance(system);
  const pupilZ = entrancePupilPlaneZ(system);
  if (!Number.isFinite(pupilZ)) return objectDistance(system);
  return pupilZ - system.vertexZAt(0);
}

/** True when the object sits at infinity, so fields are angles rather than heights. */
export function isObjectAtInfinity(system: OpticalSystem): boolean {
  return !Number.isFinite(objectDistance(system));
}

/**
 * Builds the ray that passes through a given normalized entrance-pupil point
 * from a given field.
 *
 * For an object at infinity the ray is launched from a plane in front of the
 * first surface, traveling at the field angle. For a finite object the ray
 * starts on the object surface at the field height and is aimed at the pupil
 * point. The pupil plane is the paraxial entrance pupil when the system has a
 * stop, and the first surface's vertex plane otherwise.
 */
export function generateRay(
  system: OpticalSystem,
  pupil: PupilPoint,
  options: RayGenerationOptions = {},
): Ray {
  if (!Number.isFinite(pupil.px) || !Number.isFinite(pupil.py)) {
    throw new TypeError('Pupil coordinates must be finite numbers.');
  }

  const radius = entrancePupilRadius(system);
  const wavelengthNm = options.wavelengthNm ?? system.primaryWavelengthNm;
  const field = resolveField(system, options.field, wavelengthNm);
  const rayOptions = {
    wavelengthNm,
    intensity: options.intensity ?? 1,
    medium: system.objectSurface.material.name,
  };

  const pupilZ = entrancePupilZ(system);
  const pupilPoint = new Point3(pupil.px * radius, pupil.py * radius, pupilZ);

  if (isObjectAtInfinity(system)) {
    if (field.objectHeight !== undefined) {
      throw new RangeError('An object at infinity takes field angles, not object heights.');
    }
    const angleRad = ((field.angleDeg ?? 0) * Math.PI) / 180;
    if (Math.abs(Math.cos(angleRad)) < EPSILON) {
      throw new RangeError('Field angle must be less than 90° from the optical axis.');
    }
    const direction = new Vector3(0, Math.sin(angleRad), Math.cos(angleRad));
    const startZ = options.startZ ?? defaultStartZ(system, radius, pupilZ);
    if (startZ >= pupilPoint.z) {
      throw new RangeError('startZ must lie in front of (before) the entrance pupil plane.');
    }
    // Walk backwards from the pupil point to the launch plane along the ray.
    const origin = pupilPoint.add(direction.scale((startZ - pupilPoint.z) / direction.z));
    return new Ray(origin, direction, rayOptions);
  }

  if (field.angleDeg !== undefined) {
    throw new RangeError('A finite object takes object heights, not field angles.');
  }
  const origin = new Point3(0, field.objectHeight ?? 0, system.axialPositionAt(0));
  if (pupilZ <= origin.z) {
    throw new RangeError(
      'The entrance pupil lies at or behind the object plane; rays cannot be aimed at it.',
    );
  }
  const direction = pupilPoint.subtract(origin);
  return new Ray(origin, direction, rayOptions);
}

/**
 * The paraxial image height a field point lands at.
 *
 * The chief ray is the one through the center of the entrance pupil, so this is
 * that ray traced paraxially and produced to the image surface. Traced
 * *paraxially* on purpose: an image height stated as a field is Zemax's type 2,
 * "paraxial image height", and the whole point of it is that it is a first-order
 * statement — a real ray would land somewhere slightly else and would make the
 * field depend on the aberrations it is supposed to be measuring.
 */
export function paraxialImageHeight(
  system: OpticalSystem,
  field: Field,
  wavelengthNm: number = system.primaryWavelengthNm,
): number {
  const pupilZ = entrancePupilPlaneZ(system, wavelengthNm);
  const firstZ = system.axialPositionAt(1);

  let height: number;
  let angle: number;
  if (isObjectAtInfinity(system)) {
    // A paraxial slope is a tangent, not an angle: the ray's height grows with
    // `tan θ` and nothing here is linear in degrees.
    angle = Math.tan(((field.angleDeg ?? 0) * Math.PI) / 180);
    height = -angle * (pupilZ - firstZ);
  } else {
    const objectZ = system.axialPositionAt(0);
    const start = field.objectHeight ?? 0;
    angle = -start / (pupilZ - objectZ);
    height = start + angle * (firstZ - objectZ);
  }

  const states = paraxialTrace(system, { height, angle }, wavelengthNm);
  const exit = states[states.length - 1]!;
  const lastZ = system.axialPositionAt(states.length);

  // **The paraxial image plane, not the image surface.** They are the same plane
  // on a system in focus and they are not on one that is deliberately out of it —
  // which for eye work is the normal case, since a refractive error *is* a
  // defocus. Measuring at the surface would make the field a function of where
  // the detector happens to sit, so running Quick focus would silently change
  // which field points the design has. Measuring at the paraxial image keeps a
  // stated field meaning one thing however the image plane moves.
  const properties = paraxialProperties(system, wavelengthNm);
  if (!Number.isFinite(properties.paraxialImageZ)) {
    throw new RangeError(
      'This system forms no paraxial image, so a field cannot be an image height.',
    );
  }
  return exit.height + exit.angleAfter * (properties.paraxialImageZ - lastZ);
}

/**
 * The object-space field that lands its chief ray at a given paraxial image
 * height — the inverse of {@link paraxialImageHeight}, and what turns a field
 * stated the way an eye model states it into one the tracer can launch.
 *
 * **Exact, not iterative.** Paraxial optics is linear in field, so one probe ray
 * gives the constant of proportionality and the answer follows by division. For
 * an object at infinity the linear quantity is `tan θ` rather than θ, so the
 * probe is taken at 45° — where the tangent is one — and the result comes back
 * through `atan`.
 */
export function fieldForImageHeight(
  system: OpticalSystem,
  imageHeight: number,
  wavelengthNm: number = system.primaryWavelengthNm,
): Field {
  if (!Number.isFinite(imageHeight)) {
    throw new RangeError('A field image height must be a finite number.');
  }
  const infinite = isObjectAtInfinity(system);
  const probe: Field = infinite ? { angleDeg: 45 } : { objectHeight: 1 };
  const perUnit = paraxialImageHeight(system, probe, wavelengthNm);

  if (!Number.isFinite(perUnit) || Math.abs(perUnit) < EPSILON) {
    throw new RangeError(
      'This system forms no paraxial image height from a field, so a field cannot be ' +
        'stated as one. An afocal system is the usual reason.',
    );
  }
  return infinite
    ? { angleDeg: (Math.atan(imageHeight / perUnit) * 180) / Math.PI }
    : { objectHeight: imageHeight / perUnit };
}

/**
 * A field the tracer can launch: an image-height field resolved into the
 * object-space one that produces it, and anything else left alone.
 *
 * `generateRay` calls this, so nothing downstream has to know the third kind
 * exists. The fan and grid generators resolve **once** and pass the result down,
 * since resolving costs a pupil solve and a paraxial trace and the answer is the
 * same for every ray of a field.
 */
export function launchableField(
  system: OpticalSystem,
  field: Field,
  wavelengthNm: number = system.primaryWavelengthNm,
): Field {
  return field.imageHeight === undefined
    ? field
    : fieldForImageHeight(system, field.imageHeight, wavelengthNm);
}

/**
 * The chief (principal) ray of a field: the one through the center of the
 * entrance pupil. It defines the image height of that field point.
 */
export function generateChiefRay(system: OpticalSystem, options: RayGenerationOptions = {}): Ray {
  return generateRay(system, { px: 0, py: 0 }, options);
}

/**
 * A marginal ray of a field: the one through the pupil rim. Defaults to the top
 * of the pupil; pass `edge: -1` for the bottom.
 */
export function generateMarginalRay(
  system: OpticalSystem,
  options: RayGenerationOptions & { edge?: 1 | -1 } = {},
): Ray {
  return generateRay(system, { px: 0, py: options.edge ?? 1 }, options);
}

/**
 * A fan of rays evenly spaced across one pupil diameter — the standard input for
 * ray-fan (transverse aberration) plots.
 */
export function generateRayFan(system: OpticalSystem, options: RayFanOptions = {}): Ray[] {
  const count = options.count ?? 11;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('Ray fan count must be a positive integer.');
  }
  const axis = options.axis ?? 'y';

  const rays: Ray[] = [];
  for (let i = 0; i < count; i += 1) {
    const p = count === 1 ? 0 : -1 + (2 * i) / (count - 1);
    rays.push(generateRay(system, axis === 'y' ? { px: 0, py: p } : { px: p, py: 0 }, options));
  }
  return rays;
}

/**
 * A square grid of pupil samples clipped to the pupil rim — the standard input
 * for spot diagrams. Returned in row-major order, bottom row first.
 */
export function generatePupilGrid(system: OpticalSystem, options: PupilGridOptions = {}): Ray[] {
  const count = options.count ?? 11;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('Pupil grid count must be a positive integer.');
  }

  const rays: Ray[] = [];
  for (let row = 0; row < count; row += 1) {
    const py = count === 1 ? 0 : -1 + (2 * row) / (count - 1);
    for (let column = 0; column < count; column += 1) {
      const px = count === 1 ? 0 : -1 + (2 * column) / (count - 1);
      if (px * px + py * py <= 1 + EPSILON) {
        rays.push(generateRay(system, { px, py }, options));
      }
    }
  }
  return rays;
}

/** Traces many rays through one system, preserving input order. */
export function traceRays(system: OpticalSystem, rays: readonly Ray[]): RayTraceResult[] {
  return rays.map((ray) => traceRay(system, ray));
}

function resolveField(
  system: OpticalSystem,
  field: number | Field | undefined,
  wavelengthNm: number,
): Field {
  if (field === undefined) {
    return {};
  }
  if (typeof field !== 'number') {
    return launchableField(system, field, wavelengthNm);
  }
  const resolved = system.fields[field];
  if (!resolved) {
    throw new RangeError(`No field at index ${field}.`);
  }
  return launchableField(system, resolved, wavelengthNm);
}

/**
 * A launch plane just in front of the frontmost point of the first surface, so
 * that rays always start in object space even for a surface whose edge bulges
 * toward the object.
 */
function defaultStartZ(system: OpticalSystem, pupilRadius: number, pupilZ: number): number {
  const surface = system.surfaceAt(1);
  const height = Math.min(
    Number.isFinite(surface.semiDiameter) ? surface.semiDiameter : pupilRadius,
    pupilRadius,
  );
  const frontmost = Math.min(0, surface.sagAt(height));
  const margin = Math.max(1, 0.1 * pupilRadius);
  // Stay ahead of both the first surface and the pupil plane (which may be virtual).
  return Math.min(system.axialPositionAt(1) + frontmost, pupilZ) - margin;
}
