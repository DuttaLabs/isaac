import { Transform3 } from '../geometry/transform3.ts';
import { Surface } from './surface.ts';

export type LinearUnit = 'mm' | 'cm' | 'm' | 'in';

/** A named off-axis field point, expressed as an object-space angle or height. */
export interface Field {
  /** Field angle in degrees (for objects at infinity). */
  angleDeg?: number;
  /** Object height in system units (for finite objects). */
  objectHeight?: number;
}

export type ApertureType =
  'ENTRANCE_PUPIL_DIAMETER' | 'IMAGE_SPACE_FNUM' | 'OBJECT_SPACE_NA' | 'FLOAT_BY_STOP';

export interface Aperture {
  type: ApertureType;
  /**
   * The aperture's defining number: a diameter, an F/#, or an NA depending on
   * `type`. Not used by `FLOAT_BY_STOP`, which takes its size from the stop
   * surface's semi-diameter.
   */
  value?: number;
}

export interface OpticalSystemConfig {
  name?: string;
  units?: LinearUnit;
  /** Wavelengths in nanometers. */
  wavelengthsNm?: number[];
  primaryWavelengthIndex?: number;
  fields?: Field[];
  aperture?: Aperture;
  surfaces: Surface[];
}

/**
 * The data model that the UI and visualization layers share with the optical
 * engine. It owns the ordered surface list and the global axial geometry
 * derived from surface thicknesses.
 *
 * Axial convention: the first non-object surface's vertex sits at z = 0, and
 * every following surface is offset by the running sum of thicknesses. The
 * object surface therefore lies at negative z (or −∞ for an object at infinity).
 *
 * That running sum is a special case of the general layout, which is a chain of
 * rigid frames — see {@link poseAt}. Every surface shares the global orientation
 * until a `COORDINATE_TRANSFORM` re-points the axis, so a centered system's poses
 * are pure z translations and the two descriptions coincide.
 */
export class OpticalSystem {
  public readonly name: string;
  public readonly units: LinearUnit;
  public readonly wavelengthsNm: readonly number[];
  public readonly primaryWavelengthIndex: number;
  public readonly fields: readonly Field[];
  public readonly aperture: Aperture | undefined;
  public readonly surfaces: readonly Surface[];

  /** Frames for every surface; `undefined` only for an OBJECT at infinity. */
  private readonly poses: readonly (Transform3 | undefined)[];
  /** Unfolded distance along the axis to each surface — see `axialPositionAt`. */
  private readonly axialPositions: readonly number[];

  public constructor(config: OpticalSystemConfig) {
    const surfaces = config.surfaces;
    if (surfaces.length < 2) {
      throw new RangeError('An optical system needs at least an OBJECT and an IMAGE surface.');
    }
    if (surfaces[0]!.type !== 'OBJECT') {
      throw new RangeError('The first surface must be of type OBJECT.');
    }
    if (surfaces[surfaces.length - 1]!.type !== 'IMAGE') {
      throw new RangeError('The last surface must be of type IMAGE.');
    }

    const stops = surfaces.filter((surface) => surface.isStop);
    if (stops.length > 1) {
      throw new RangeError('A system can have at most one aperture stop.');
    }

    requireMirrorsKeepTheirMedium(surfaces);
    requireCoordinateTransformsKeepTheirMedium(surfaces);

    const wavelengthsNm = config.wavelengthsNm ?? [587.5618]; // helium d-line
    if (wavelengthsNm.length === 0) {
      throw new RangeError('At least one wavelength is required.');
    }
    const primaryWavelengthIndex = config.primaryWavelengthIndex ?? 0;
    if (
      !Number.isInteger(primaryWavelengthIndex) ||
      primaryWavelengthIndex < 0 ||
      primaryWavelengthIndex >= wavelengthsNm.length
    ) {
      throw new RangeError('primaryWavelengthIndex is out of range.');
    }

    this.name = config.name ?? 'Untitled system';
    this.units = config.units ?? 'mm';
    this.wavelengthsNm = [...wavelengthsNm];
    this.primaryWavelengthIndex = primaryWavelengthIndex;
    this.fields = config.fields ? [...config.fields] : [];
    this.aperture = config.aperture;
    this.surfaces = [...surfaces];
    this.poses = computeSurfacePoses(this.surfaces);
    this.axialPositions = computeAxialPositions(this.surfaces);
  }

  public get objectSurface(): Surface {
    return this.surfaces[0]!;
  }

  public get imageSurface(): Surface {
    return this.surfaces[this.surfaces.length - 1]!;
  }

  /** Index of the aperture stop, or `undefined` when no surface is marked as the stop. */
  public get stopIndex(): number | undefined {
    const index = this.surfaces.findIndex((surface) => surface.isStop);
    return index === -1 ? undefined : index;
  }

  public get primaryWavelengthNm(): number {
    return this.wavelengthsNm[this.primaryWavelengthIndex]!;
  }

  public surfaceAt(index: number): Surface {
    const surface = this.surfaces[index];
    if (!surface) {
      throw new RangeError(`No surface at index ${index}.`);
    }
    return surface;
  }

  /** Returns a copy with selected changes applied; the original is untouched. */
  public with(changes: Partial<OpticalSystemConfig>): OpticalSystem {
    return new OpticalSystem({
      name: changes.name ?? this.name,
      units: changes.units ?? this.units,
      wavelengthsNm: changes.wavelengthsNm ?? [...this.wavelengthsNm],
      primaryWavelengthIndex: changes.primaryWavelengthIndex ?? this.primaryWavelengthIndex,
      fields: changes.fields ?? [...this.fields],
      aperture: changes.aperture ?? this.aperture,
      surfaces: changes.surfaces ?? [...this.surfaces],
    });
  }

  /** Returns a copy with one surface replaced; axial geometry is recomputed. */
  public withSurfaceAt(index: number, surface: Surface): OpticalSystem {
    if (!this.surfaces[index]) {
      throw new RangeError(`No surface at index ${index}.`);
    }
    const surfaces = [...this.surfaces];
    surfaces[index] = surface;
    return this.with({ surfaces });
  }

  /**
   * Where a surface sits and which way it faces: the transform taking its local
   * frame (vertex at the origin, axis along +z) into global coordinates.
   *
   * For a `COORDINATE_TRANSFORM` this is the frame the transform starts from, *before*
   * its own decenter and tilt — the transform's effect lands on everything after it,
   * which is what makes it a change of frame rather than a thing in space.
   */
  public poseAt(index: number): Transform3 {
    if (index < 0 || index >= this.poses.length) {
      throw new RangeError(`No surface at index ${index}.`);
    }
    const pose = this.poses[index];
    if (pose === undefined) {
      // An object at infinity has a direction but no location, so there is no
      // frame to hand back. Callers that only want the axial coordinate can ask
      // vertexZAt, which answers −Infinity — a number the arithmetic survives.
      throw new RangeError(
        'The OBJECT surface is at infinity, so it has no position; use vertexZAt for the axial coordinate.',
      );
    }
    return pose;
  }

  /**
   * Global axial (z) position of a surface's vertex.
   *
   * Only the whole story while the system stays centered. Once a coordinate
   * transform tilts or decenters the axis a vertex has an x and a y as well, and a
   * caller that needs the geometry rather than a number wants {@link poseAt}.
   */
  public vertexZAt(index: number): number {
    if (index < 0 || index >= this.poses.length) {
      throw new RangeError(`No surface at index ${index}.`);
    }
    const pose = this.poses[index];
    return pose === undefined ? -Infinity : pose.origin.z;
  }

  /**
   * Distance along the optical axis from surface 1 to a surface's vertex — the
   * running sum of thicknesses, with the object one object-distance behind.
   *
   * This is the *unfolded* coordinate: it measures along the axis wherever the
   * axis points, so a fold mirror's tilt does not change it. That is what the
   * first-order layer wants, because the paraxial properties of a folded system
   * are those of its unfolded equivalent — an EFL does not care which way the
   * beam was bent. For a centered system it is identical to {@link vertexZAt},
   * which is why nothing needed to distinguish the two until now.
   */
  public axialPositionAt(index: number): number {
    const position = this.axialPositions[index];
    if (position === undefined) {
      throw new RangeError(`No surface at index ${index}.`);
    }
    return position;
  }

  /**
   * True when every surface still shares the global orientation and sits on the
   * axis — no coordinate transform has moved anything.
   *
   * The paraxial layer and both layout views are built on a straight axis, so
   * this is what they test before describing a system in those terms.
   */
  public get isCentered(): boolean {
    return this.poses.every((pose) => pose === undefined || pose.isAxial);
  }
}

/**
 * A mirror sends the light back into the medium it came from, so the medium
 * after it is the medium before it — always.
 *
 * Worth refusing rather than quietly correcting, because the two readings of a
 * mirror's `material` disagree in a way nothing downstream would notice. The
 * paraxial recurrence takes the magnitude from the previous medium, so it would
 * ignore a wrong value; the real tracer reads `material` directly to get the
 * index the *next* surface refracts from, so it would use it. A Mangin mirror
 * whose material said AIR would trace as though the glass had vanished on the
 * way back out, and still produce a plausible-looking spot diagram.
 */
function requireMirrorsKeepTheirMedium(surfaces: readonly Surface[]): void {
  for (let index = 1; index < surfaces.length; index += 1) {
    const surface = surfaces[index]!;
    if (!surface.reflective) {
      continue;
    }
    const before = surfaces[index - 1]!.material;
    if (before.name.toUpperCase() !== surface.material.name.toUpperCase()) {
      throw new RangeError(
        `Surface ${index} is a mirror, so the medium after it must be the medium before it ` +
          `(${before.name}), not ${surface.material.name}.`,
      );
    }
  }
}

/**
 * A coordinate transform carries no glass: it cannot be the boundary between two
 * media, which is why Zemax shows "-" where its glass name would go. The medium
 * after it is therefore the medium before it.
 *
 * Refused rather than quietly corrected, for the same reason as a mirror's: the
 * tracer walks back past transforms to find the medium a ray crossed, so a wrong
 * value here would be ignored by the trace and believed by anything reading the
 * surface directly — the two would disagree with nothing to say so.
 */
function requireCoordinateTransformsKeepTheirMedium(surfaces: readonly Surface[]): void {
  for (let index = 1; index < surfaces.length; index += 1) {
    const surface = surfaces[index]!;
    if (surface.type !== 'COORDINATE_TRANSFORM') {
      continue;
    }
    const before = surfaces[index - 1]!.material;
    if (before.name.toUpperCase() !== surface.material.name.toUpperCase()) {
      throw new RangeError(
        `Surface ${index} is a coordinate transform, so the medium after it must be the medium ` +
          `before it (${before.name}), not ${surface.material.name}.`,
      );
    }
  }
}

/**
 * Distance along the axis to each surface: surface 1 at zero, the running sum of
 * thicknesses after it, and the object one object-distance behind (possibly −∞).
 *
 * Deliberately blind to tilts and decenters. A coordinate transform re-points the
 * axis but does not change how far along it anything is, so this is the
 * unfolded coordinate the paraxial layer works in.
 */
function computeAxialPositions(surfaces: readonly Surface[]): number[] {
  const positions = new Array<number>(surfaces.length);
  positions[1] = 0;
  for (let i = 2; i < surfaces.length; i += 1) {
    positions[i] = positions[i - 1]! + surfaces[i - 1]!.thickness;
  }
  positions[0] = 0 - surfaces[0]!.thickness;
  return positions;
}

/**
 * Walks the surface list accumulating a frame, and records where each surface
 * lands. Surface index 1 anchors the system at the origin, facing +z.
 *
 * Each step does two things: a coordinate transform re-points the frame by its own
 * decenter and tilt, and then the thickness advances along whatever axis the
 * frame now has. Both are pure compositions, which is why a system with no
 * transforms comes out as a plain running sum of thicknesses along z — the axial
 * layout every centered design has, unchanged.
 *
 * Thicknesses after a mirror are negative — the distance to the next surface
 * measured along +z, which is behind the light once it has turned around — and
 * that arithmetic survives the generalization untouched. It is the convention
 * `.zmx` files are written in, and it is why a fold needs a transform for its tilt
 * but nothing extra for its spacing.
 */
function computeSurfacePoses(surfaces: readonly Surface[]): (Transform3 | undefined)[] {
  const poses = new Array<Transform3 | undefined>(surfaces.length);

  let frame = Transform3.identity();
  for (let i = 1; i < surfaces.length; i += 1) {
    poses[i] = frame;
    const surface = surfaces[i]!;
    // The transform's own frame change applies to everything downstream, and the
    // thickness is applied last either way — the manual is explicit about that.
    frame = frame.compose(surface.frameChange).compose(Transform3.axialShift(surface.thickness));
  }

  // The object sits an object-distance behind surface 1, in the frame surface 1
  // starts from — nothing can have moved the axis yet. An object at infinity has
  // no position at all, and says so rather than holding a non-finite point.
  const objectDistance = surfaces[0]!.thickness;
  poses[0] = Number.isFinite(objectDistance) ? Transform3.axialShift(-objectDistance) : undefined;
  return poses;
}
