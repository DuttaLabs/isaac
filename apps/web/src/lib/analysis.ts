import {
  entrancePupil,
  entrancePupilRadius,
  exitPupil,
  generateChiefRay,
  generateMarginalRay,
  generatePupilGrid,
  generateRay,
  generateRayFan,
  paraxialProperties,
  traceRay,
  traceRays,
  type Field,
  type OpticalSystem,
  type ParaxialProperties,
  type Pupil,
  type RayTraceResult,
} from '@isaac/optical-core';
import { attempt, type Result } from './result.ts';

/** How a field is addressed when the system may have no field list at all. */
export function fieldOption(system: OpticalSystem, index: number): number | Field | undefined {
  return system.fields.length > 0 ? Math.min(index, system.fields.length - 1) : undefined;
}

export interface FirstOrder {
  properties: ParaxialProperties;
  entrancePupilRadius: number;
  fNumber: number | undefined;
  entrance: Pupil | undefined;
  exit: Pupil | undefined;
}

/**
 * First-order summary. The pupil solves and the F/# are computed separately from
 * the paraxial properties because each has its own reasons to be unavailable —
 * no stop, a telecentric pupil, a finite conjugate — and one missing value
 * should not blank the rest of the panel.
 */
export function computeFirstOrder(system: OpticalSystem): Result<FirstOrder> {
  return attempt(() => {
    const properties = paraxialProperties(system);
    const radius = entrancePupilRadius(system);
    const efl = properties.effectiveFocalLength;
    return {
      properties,
      entrancePupilRadius: radius,
      fNumber: Number.isFinite(efl) && radius > 0 ? Math.abs(efl) / (2 * radius) : undefined,
      entrance: system.stopIndex === undefined ? undefined : tryPupil(() => entrancePupil(system)),
      exit: system.stopIndex === undefined ? undefined : tryPupil(() => exitPupil(system)),
    };
  });
}

function tryPupil(compute: () => Pupil): Pupil | undefined {
  const result = attempt(compute);
  return result.ok ? result.value : undefined;
}

/**
 * The two rays first-order optics is built out of, traced for the layout to draw.
 *
 * Which two is not arbitrary, and it is the whole reason this is worth showing.
 * The **marginal ray** leaves the *axial* object point and grazes the rim of the
 * pupil: it is the ray that meets the aperture, so it fixes the F/#, the depth of
 * focus, and where the image lies. The **chief ray** leaves the *outermost* field
 * point and passes through the *center* of the pupil: it is the ray that meets
 * the field, so it fixes the image height and the sizes every element has to be.
 *
 * Together they bound the beam — every other ray in the system is a combination
 * of the two — and where each crosses the axis is a pupil or an image. That pair
 * is the classical textbook figure, and it is why one ray is taken from the axis
 * and the other from the edge of the field rather than both from every field.
 */
export interface FirstOrderRays {
  /** Axial field, pupil rim. */
  marginal: RayTraceResult;
  /** Outermost field, pupil center. */
  chief: RayTraceResult;
  /** How the chief ray's field reads, for the legend: `5°` or `12 mm`. */
  chiefField: string;
}

/**
 * Traces the marginal and chief rays at the primary wavelength.
 *
 * Only the primary: these are construction lines for the first-order layout, and
 * first-order optics has no color in it. Drawing one per wavelength would add
 * three near-identical rays that say nothing the ray fan does not already say.
 */
export function computeFirstOrderRays(system: OpticalSystem): Result<FirstOrderRays> {
  return attempt(() => {
    const wavelengthNm = system.primaryWavelengthNm;
    const outer = outermostFieldIndex(system);
    return {
      marginal: traceRay(
        system,
        generateMarginalRay(system, { field: fieldOption(system, 0), wavelengthNm }),
      ),
      chief: traceRay(
        system,
        generateChiefRay(system, { field: fieldOption(system, outer), wavelengthNm }),
      ),
      chiefField: describeField(system.fields[outer]),
    };
  });
}

/**
 * The field furthest off axis. Field lists are usually written in order, but
 * nothing enforces that, so the largest is found rather than assumed last.
 */
function outermostFieldIndex(system: OpticalSystem): number {
  let best = 0;
  let largest = -Infinity;
  for (const [index, field] of system.fields.entries()) {
    const magnitude = Math.abs(field.angleDeg ?? field.objectHeight ?? 0);
    if (magnitude > largest) {
      largest = magnitude;
      best = index;
    }
  }
  return best;
}

function describeField(field: Field | undefined): string {
  if (field === undefined) {
    return 'on axis';
  }
  if (field.angleDeg !== undefined) {
    return `${Number(field.angleDeg.toFixed(4))}°`;
  }
  if (field.objectHeight !== undefined) {
    return `${Number(field.objectHeight.toFixed(4))} height`;
  }
  return 'on axis';
}

export interface LayoutTrace {
  result: RayTraceResult;
  wavelengthIndex: number;
  fieldIndex: number;
}

/** Traces a fan per field for the layout drawing. */
export function computeLayoutTraces(
  system: OpticalSystem,
  options: { raysPerFan: number; wavelengthIndices: readonly number[] },
): Result<LayoutTrace[]> {
  return attempt(() => {
    const traces: LayoutTrace[] = [];
    const fieldCount = Math.max(system.fields.length, 1);

    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
      for (const wavelengthIndex of options.wavelengthIndices) {
        const wavelengthNm = system.wavelengthsNm[wavelengthIndex];
        if (wavelengthNm === undefined) {
          continue;
        }
        const rays = generateRayFan(system, {
          field: fieldOption(system, fieldIndex),
          wavelengthNm,
          count: options.raysPerFan,
        });
        for (const result of traceRays(system, rays)) {
          traces.push({ result, wavelengthIndex, fieldIndex });
        }
      }
    }
    return traces;
  });
}

/**
 * Traces a pupil grid per field: the rays a 3-D layout wants.
 *
 * The meridional fan the 2-D view draws lies in one plane, and in three
 * dimensions that reads as a flat sheet standing in the middle of the lens. A
 * grid fills the cone instead, which is what the beam actually is — the tracer
 * has always worked in three dimensions, so this asks it for rays that use
 * them.
 */
export function computeVolumeTraces(
  system: OpticalSystem,
  options: { gridCount: number; wavelengthIndices: readonly number[] },
): Result<LayoutTrace[]> {
  return attempt(() => {
    const traces: LayoutTrace[] = [];
    const fieldCount = Math.max(system.fields.length, 1);

    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
      for (const wavelengthIndex of options.wavelengthIndices) {
        const wavelengthNm = system.wavelengthsNm[wavelengthIndex];
        if (wavelengthNm === undefined) {
          continue;
        }
        const rays = generatePupilGrid(system, {
          field: fieldOption(system, fieldIndex),
          wavelengthNm,
          count: options.gridCount,
        });
        for (const result of traceRays(system, rays)) {
          traces.push({ result, wavelengthIndex, fieldIndex });
        }
      }
    }
    return traces;
  });
}

export interface FanSeries {
  wavelengthIndex: number;
  wavelengthNm: number;
  points: { pupil: number; error: number }[];
  blocked: number;
}

export interface RayFanData {
  series: FanSeries[];
  maxError: number;
  referenceHeight: number;
}

/**
 * Transverse ray aberration across the pupil: how far each ray lands from the
 * chief ray of the same field, measured at the image surface. The reference is
 * the chief ray at the primary wavelength, so the curves also show lateral
 * color rather than hiding it.
 */
export function computeRayFan(
  system: OpticalSystem,
  fieldIndex: number,
  count: number,
): Result<RayFanData> {
  return attempt(() => {
    const field = fieldOption(system, fieldIndex);
    const referenceHeight = chiefRayHeight(system, field, system.primaryWavelengthNm);

    const series = system.wavelengthsNm.map((wavelengthNm, wavelengthIndex) => {
      const points: { pupil: number; error: number }[] = [];
      let blocked = 0;

      for (let i = 0; i < count; i += 1) {
        const pupil = count === 1 ? 0 : -1 + (2 * i) / (count - 1);
        const trace = attempt(() =>
          traceRay(system, generateRay(system, { px: 0, py: pupil }, { field, wavelengthNm })),
        );
        if (!trace.ok || trace.value.status !== 'TERMINATED') {
          blocked += 1;
          continue;
        }
        points.push({ pupil, error: trace.value.finalRay.origin.y - referenceHeight });
      }
      return { wavelengthIndex, wavelengthNm, points, blocked };
    });

    const maxError = Math.max(
      1e-6,
      ...series.flatMap((entry) => entry.points.map((point) => Math.abs(point.error))),
    );
    return { series, maxError, referenceHeight };
  });
}

export interface SpotSeries {
  wavelengthIndex: number;
  wavelengthNm: number;
  points: { x: number; y: number }[];
}

export interface SpotData {
  series: SpotSeries[];
  /** RMS radius over every traced ray, in system units. */
  rmsRadius: number;
  /** Distance of the furthest ray from the reference point. */
  maxRadius: number;
  /** Rays that never reached the image, wherever they were lost. */
  blocked: number;
  /**
   * Rays stopped by the image surface's own aperture — the subset of
   * {@link blocked} that moving the image plane can do something about. Rays lost
   * earlier are lost at every focus, so telling the two apart is what lets the
   * focus search charge for the ones it is responsible for and no others.
   */
  blockedAtImage: number;
  traced: number;
}

/**
 * Spot diagram: where a grid of pupil rays lands at the image surface, relative
 * to the chief ray of the field. This is geometric only — diffraction is
 * deliberately outside the engine's scope, so there is no Airy disc here.
 */
export function computeSpot(
  system: OpticalSystem,
  fieldIndex: number,
  gridCount: number,
): Result<SpotData> {
  return attempt(() => {
    const field = fieldOption(system, fieldIndex);
    const referenceHeight = chiefRayHeight(system, field, system.primaryWavelengthNm);

    let sumSquares = 0;
    let traced = 0;
    let blocked = 0;
    let blockedAtImage = 0;
    let maxRadius = 0;
    const imageIndex = system.surfaces.length - 1;

    const series = system.wavelengthsNm.map((wavelengthNm, wavelengthIndex) => {
      const points: { x: number; y: number }[] = [];
      const rays = generatePupilGrid(system, { field, wavelengthNm, count: gridCount });

      for (const result of traceRays(system, rays)) {
        if (result.status !== 'TERMINATED') {
          blocked += 1;
          if (result.status === 'BLOCKED' && result.terminatedAtSurface === imageIndex) {
            blockedAtImage += 1;
          }
          continue;
        }
        const x = result.finalRay.origin.x;
        const y = result.finalRay.origin.y - referenceHeight;
        points.push({ x, y });
        sumSquares += x * x + y * y;
        maxRadius = Math.max(maxRadius, Math.hypot(x, y));
        traced += 1;
      }
      return { wavelengthIndex, wavelengthNm, points };
    });

    return {
      series,
      rmsRadius: traced > 0 ? Math.sqrt(sumSquares / traced) : 0,
      maxRadius,
      blocked,
      blockedAtImage,
      traced,
    };
  });
}

/** Image height of the chief ray, the reference every aberration is measured from. */
function chiefRayHeight(
  system: OpticalSystem,
  field: number | Field | undefined,
  wavelengthNm: number,
): number {
  const trace = attempt(() => traceRay(system, generateChiefRay(system, { field, wavelengthNm })));
  if (!trace.ok || trace.value.status !== 'TERMINATED') {
    return 0;
  }
  return trace.value.finalRay.origin.y;
}
