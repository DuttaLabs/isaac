import {
  entrancePupil,
  entrancePupilRadius,
  exitPupil,
  generateChiefRay,
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
  blocked: number;
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
    let maxRadius = 0;

    const series = system.wavelengthsNm.map((wavelengthNm, wavelengthIndex) => {
      const points: { x: number; y: number }[] = [];
      const rays = generatePupilGrid(system, { field, wavelengthNm, count: gridCount });

      for (const result of traceRays(system, rays)) {
        if (result.status !== 'TERMINATED') {
          blocked += 1;
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
