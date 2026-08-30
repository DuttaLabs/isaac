import {
  AIR,
  OpticalSystem,
  Surface,
  type CoordinateTransform,
  type Material,
  type SurfaceAperture,
} from '@isaac/optical-core';
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
    /** Conic constant; every surface with a radius accepts one. */
    conic?: number;
    /** `α₁…αₙ` on r², r⁴, …; only an EVEN_ASPHERE surface accepts them. */
    asphericCoefficients?: readonly number[];
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

/**
 * Sets — or removes — what stops light at one surface.
 *
 * Its own edit rather than a field on {@link updateSurface}, because removing an
 * aperture has to be expressible: `with({ aperture: undefined })` means "take it
 * off", and a `changes` object where every key is optional cannot tell that
 * apart from "leave it alone". The model refuses an aperture on a coordinate
 * transform and an inverted ring, so a rejected edit leaves the design on screen
 * with a message rather than a half-applied change.
 */
export function setSurfaceAperture(
  system: OpticalSystem,
  index: number,
  aperture: SurfaceAperture | undefined,
): Result<OpticalSystem> {
  return attempt(() => system.withSurfaceAt(index, system.surfaceAt(index).with({ aperture })));
}

/**
 * Renames the lens: the `NAME` record a .zmx carries, which describes the design
 * ("A SIMPLE DOUBLET USING A CROWN AND A FLINT.") and is not the name of the
 * file it lives in — that is view state and never touches the model.
 *
 * Whitespace is collapsed because the record is whitespace-delimited: a name is
 * read back by splitting on runs of it and re-joining with single spaces, so
 * "A  B" would come back "A B" and a newline would end the record and turn the
 * rest of the name into a garbage token. Normalizing here means what is typed is
 * what survives a save, rather than something close to it.
 *
 * An empty name is refused rather than stored. Every file carries the record, and
 * a blank one reads back as "Untitled system" — the name would appear to survive
 * the save and quietly not.
 */
export function renameSystem(system: OpticalSystem, name: string): Result<OpticalSystem> {
  return attempt(() => {
    const cleaned = name.replace(/\s+/g, ' ').trim();
    if (cleaned === '') {
      throw new RangeError('A lens needs a name — it is written into the file as its NAME record.');
    }
    return system.with({ name: cleaned });
  });
}

/** Focal length a surface starts with when it is first made paraxial. */
export const DEFAULT_PARAXIAL_FOCAL_LENGTH = 100;

/** The surface types a user can choose between; OBJECT and IMAGE are fixed by position. */
export type EditableSurfaceType = 'STANDARD' | 'EVEN_ASPHERE' | 'PARAXIAL' | 'COORDINATE_TRANSFORM';

/** A coordinate transform starts flat: it is added first and aimed afterwards. */
export const ZERO_COORDINATE_TRANSFORM: CoordinateTransform = {
  decenterX: 0,
  decenterY: 0,
  tiltXDeg: 0,
  tiltYDeg: 0,
  tiltZDeg: 0,
  tiltFirst: false,
};

/**
 * Switches a surface between the types a user may choose.
 *
 * This rebuilds the surface rather than going through `.with()`, because the
 * types carry mutually exclusive geometry: a STANDARD surface has a radius and
 * no focal length, a PARAXIAL surface the reverse, and `.with()` can only add
 * fields, never drop them. Going paraxial therefore discards the radius, and
 * coming back leaves a plane — there is no index-independent way to turn one
 * into the other, so neither is silently invented.
 *
 * STANDARD and EVEN_ASPHERE are the one pair that *does* convert cleanly: they
 * are the same conic surface, one of them carrying a polynomial as well. So the
 * radius and conic follow the surface across in both directions, and only the
 * coefficients — which have nowhere to live on a STANDARD surface — are dropped
 * on the way back. That is the conversion a designer actually performs, turning
 * a spherical element aspheric once the design needs it.
 *
 * COORDINATE_TRANSFORM drops the most: it has no shape, no aperture and no glass of
 * its own, so a surface becoming one keeps only its thickness and its place in
 * the list. It also takes the medium of the surface before it, which is the one
 * value the model insists on — a transform cannot be a boundary between two media.
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

    if (type === 'COORDINATE_TRANSFORM') {
      return system.withSurfaceAt(
        index,
        new Surface({
          id: surface.id,
          type,
          thickness: surface.thickness,
          coordinateTransform: ZERO_COORDINATE_TRANSFORM,
          // The medium must match the surface before, and a transform can carry no
          // aperture, no shape, no stop and no mirror — the model refuses each.
          material: system.surfaceAt(index - 1).material,
          comment: surface.comment,
        }),
      );
    }

    const shaped =
      surface.type !== 'PARAXIAL' && surface.type !== 'COORDINATE_TRANSFORM' && type !== 'PARAXIAL';
    return system.withSurfaceAt(
      index,
      new Surface({
        id: surface.id,
        type,
        thickness: surface.thickness,
        semiDiameter: surface.semiDiameter,
        material: surface.material,
        reflective: surface.reflective,
        isStop: surface.isStop,
        comment: surface.comment,
        ...(type === 'PARAXIAL'
          ? { focalLength: DEFAULT_PARAXIAL_FOCAL_LENGTH }
          : { radius: shaped ? surface.radius : Infinity, conic: shaped ? surface.conic : 0 }),
        ...(type === 'EVEN_ASPHERE' ? { asphericCoefficients: surface.asphericCoefficients } : {}),
      }),
    );
  });
}

/**
 * Turns a surface into a mirror, or back into a refracting one.
 *
 * Two things move together, because a mirror cannot be described by one of them
 * alone. The **medium** becomes the medium before the surface: light comes back
 * out the way it went in, and the model refuses a mirror that claims otherwise.
 * The **thickness** changes sign: it is the distance to the next surface
 * measured along +Z, and +Z is now behind the light, so leaving it positive puts
 * the rest of the design where no light goes and every ray comes back MISSED.
 *
 * Only this surface's own thickness is flipped, not the whole train after it.
 * That is the minimum that makes the common case — a mirror with the image plane
 * after it — work on the first try, and it is exactly reversible. A longer arm
 * behind a fold still has to be laid out by hand, which is the same bargain
 * OpticStudio strikes.
 */
export function setMirror(
  system: OpticalSystem,
  index: number,
  reflective: boolean,
): Result<OpticalSystem> {
  return attempt(() => {
    const surface = system.surfaceAt(index);
    if (surface.reflective === reflective) {
      return system;
    }
    if (index === 0 || index === system.surfaces.length - 1) {
      throw new RangeError('The object and image surfaces record rays; they cannot reflect.');
    }
    if (surface.type === 'PARAXIAL') {
      throw new RangeError('A PARAXIAL surface is an ideal lens; it cannot be a mirror.');
    }
    return system.withSurfaceAt(
      index,
      surface.with({
        reflective,
        material: reflective ? system.surfaceAt(index - 1).material : surface.material,
        thickness: -surface.thickness,
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

/**
 * Inserts a plane air surface after `index`, splitting nothing else.
 *
 * Refused on the last surface. The model would refuse it too — the image plane
 * has to be last — but by then the message is about an invariant rather than
 * about what the user just asked for, and the two ends of the system are the
 * one place this is worth saying in their own words.
 */
export function insertSurfaceAfter(system: OpticalSystem, index: number): Result<OpticalSystem> {
  return attempt(() => {
    if (index >= system.surfaces.length - 1) {
      throw new RangeError(
        'Nothing can go below the image surface: the image plane has to be the last one.',
      );
    }
    return insertSurfaceAt(system, index + 1);
  });
}

/** Inserts a plane air surface before `index`; the mirror image of the above. */
export function insertSurfaceBefore(system: OpticalSystem, index: number): Result<OpticalSystem> {
  return attempt(() => {
    if (index <= 0) {
      throw new RangeError(
        'Nothing can go above the object surface: the object has to be the first one.',
      );
    }
    return insertSurfaceAt(system, index);
  });
}

/**
 * The new surface, and where it lands. A plane in air, because that is the one
 * shape that changes no ray: an inserted surface should leave the design tracing
 * exactly as it did until the user gives it a radius.
 */
function insertSurfaceAt(system: OpticalSystem, at: number): OpticalSystem {
  const surfaces = [...system.surfaces];
  surfaces.splice(
    at,
    0,
    new Surface({
      id: newSurfaceId(),
      type: 'STANDARD',
      radius: Infinity,
      thickness: 5,
      // The surface it is going under, whichever end the insert came from, so a
      // new row is the size of its neighbours rather than of the whole system.
      semiDiameter: nearbySemiDiameter(system, at - 1),
      material: AIR,
    }),
  );
  return system.with({ surfaces });
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
  const neighbor = system.surfaces[index] ?? system.surfaces[1];
  const semiDiameter = neighbor?.semiDiameter ?? 10;
  return Number.isFinite(semiDiameter) ? semiDiameter : 10;
}

/**
 * Changes one of a coordinate transform's six numbers.
 *
 * Kept as a whole-object replacement rather than a field patch because the
 * model takes them together: five quantities and the flag that says which half
 * happens first, and the flag changes what the other five mean.
 */
export function updateCoordinateTransform(
  system: OpticalSystem,
  index: number,
  changes: Partial<CoordinateTransform>,
): Result<OpticalSystem> {
  return attempt(() => {
    const surface = system.surfaceAt(index);
    const current = surface.coordinateTransform;
    if (current === undefined) {
      throw new RangeError(`Surface ${index} is not a coordinate transform.`);
    }
    return system.withSurfaceAt(
      index,
      surface.with({ coordinateTransform: { ...current, ...changes } }),
    );
  });
}
