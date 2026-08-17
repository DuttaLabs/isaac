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
 */
export class OpticalSystem {
  public readonly name: string;
  public readonly units: LinearUnit;
  public readonly wavelengthsNm: readonly number[];
  public readonly primaryWavelengthIndex: number;
  public readonly fields: readonly Field[];
  public readonly aperture: Aperture | undefined;
  public readonly surfaces: readonly Surface[];

  private readonly vertexZ: readonly number[];

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
    this.vertexZ = computeVertexPositions(this.surfaces);
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

  /** Global axial (z) position of a surface's vertex. */
  public vertexZAt(index: number): number {
    const z = this.vertexZ[index];
    if (z === undefined) {
      throw new RangeError(`No surface at index ${index}.`);
    }
    return z;
  }
}

/**
 * Places the first non-object surface at z = 0 and accumulates thicknesses
 * forward; the object surface is positioned one object-distance behind it.
 */
function computeVertexPositions(surfaces: readonly Surface[]): number[] {
  const positions = new Array<number>(surfaces.length);
  // Surface index 1 (first surface after OBJECT) anchors the system at z = 0.
  positions[1] = 0;
  for (let i = 2; i < surfaces.length; i += 1) {
    positions[i] = positions[i - 1]! + surfaces[i - 1]!.thickness;
  }
  // Object surface sits an object-distance behind surface 1 (may be −∞).
  positions[0] = 0 - surfaces[0]!.thickness;
  return positions;
}
