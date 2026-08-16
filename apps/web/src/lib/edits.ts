import { AIR, OpticalSystem, Surface, type Material } from '@isaac/optical-core';
import { newSurfaceId } from './default-system.ts';
import { attempt, type Result } from './result.ts';

/**
 * Every edit returns a new system, and every edit can be rejected: the model
 * validates aggressively in its constructor. Editors call these and show the
 * error rather than applying an invalid change.
 */

export function updateSurface(
  system: OpticalSystem,
  index: number,
  changes: {
    radius?: number;
    /** Ideal-lens focal length; only a PARAXIAL surface accepts one. */
    focalLength?: number;
    thickness?: number;
    semiDiameter?: number;
    material?: Material;
    /** Zemax's per-surface comment. Pass '' to clear it. */
    comment?: string;
  },
): Result<OpticalSystem> {
  return attempt(() => system.withSurfaceAt(index, system.surfaceAt(index).with(changes)));
}

/** Focal length a surface starts with when it is first made paraxial. */
export const DEFAULT_PARAXIAL_FOCAL_LENGTH = 100;

/** The surface types a user can choose between; OBJECT and IMAGE are fixed by position. */
export type EditableSurfaceType = 'STANDARD' | 'PARAXIAL';

/**
 * Switches a surface between STANDARD and PARAXIAL.
 *
 * This rebuilds the surface rather than going through `.with()`, because the two
 * types carry mutually exclusive geometry: a STANDARD surface has a radius and
 * no focal length, a PARAXIAL surface the reverse, and `.with()` can only add
 * fields, never drop them. Going paraxial therefore discards the radius, and
 * coming back leaves a plane — there is no index-independent way to turn one
 * into the other, so neither is silently invented.
 */
export function setSurfaceType(
  system: OpticalSystem,
  index: number,
  type: EditableSurfaceType,
): Result<OpticalSystem> {
  return attempt(() => {
    const surface = system.surfaceAt(index);
    if (surface.type === 'OBJECT' || surface.type === 'IMAGE') {
      throw new RangeError('The object and image surfaces cannot change type.');
    }
    if (surface.type === type) {
      return system;
    }

    return system.withSurfaceAt(
      index,
      new Surface({
        id: surface.id,
        type,
        thickness: surface.thickness,
        semiDiameter: surface.semiDiameter,
        material: surface.material,
        isStop: surface.isStop,
        comment: surface.comment,
        ...(type === 'PARAXIAL'
          ? { focalLength: DEFAULT_PARAXIAL_FOCAL_LENGTH }
          : { radius: Infinity }),
      }),
    );
  });
}

/** Moves the stop to one surface, clearing it everywhere else. */
export function setStop(system: OpticalSystem, index: number): Result<OpticalSystem> {
  return attempt(() =>
    system.with({
      surfaces: system.surfaces.map((surface, i) => surface.with({ isStop: i === index })),
    }),
  );
}

/** Inserts a plane air surface after `index`, splitting nothing else. */
export function insertSurfaceAfter(system: OpticalSystem, index: number): Result<OpticalSystem> {
  return attempt(() => {
    const surfaces = [...system.surfaces];
    surfaces.splice(index + 1, 0,
      new Surface({
        id: newSurfaceId(),
        type: 'STANDARD',
        radius: Infinity,
        thickness: 5,
        semiDiameter: nearbySemiDiameter(system, index),
        material: AIR,
      }),
    );
    return system.with({ surfaces });
  });
}

export function removeSurface(system: OpticalSystem, index: number): Result<OpticalSystem> {
  return attempt(() => {
    const surface = system.surfaceAt(index);
    if (surface.type === 'OBJECT' || surface.type === 'IMAGE') {
      throw new RangeError('The object and image surfaces cannot be removed.');
    }
    return system.with({ surfaces: system.surfaces.filter((_, i) => i !== index) });
  });
}

/**
 * A radius of zero is meaningless (the model rejects it), but it is what a user
 * types for "flat". Curvature zero is the plane, so map it to an infinite radius.
 */
export function normalizeRadius(value: number): number {
  return value === 0 ? Infinity : value;
}

/** Zemax writes an unapertured surface as diameter 0; the model wants Infinity. */
export function normalizeSemiDiameter(value: number): number {
  return value <= 0 ? Infinity : value;
}

function nearbySemiDiameter(system: OpticalSystem, index: number): number {
  const neighbour = system.surfaces[index] ?? system.surfaces[1];
  const semiDiameter = neighbour?.semiDiameter ?? 10;
  return Number.isFinite(semiDiameter) ? semiDiameter : 10;
}
