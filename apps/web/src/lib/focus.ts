import {
  apertureClearRadius,
  withImageAtParaxialFocus,
  type OpticalSystem,
} from '@isaac/optical-core';
import { computeSpot } from './analysis.ts';
import { attempt, type Result } from './result.ts';

/**
 * Quick focus: moves the image plane to where the geometric spot is smallest.
 *
 * This is a one-variable search, not an optimizer. `Architecture.md` keeps
 * optimization out of `optical-core`, and nothing here goes near it: the engine
 * is asked for spot sizes through its public API and the search sits in the UI
 * layer, so the engine stays a calculator.
 *
 * The variable is the thickness of the surface before the image — the only one
 * that moves the image plane without changing the design. The figure of merit is
 * the RMS spot radius pooled over every field and wavelength, each measured from
 * its own chief ray, so the merit answers "how tight is the image" and not "how
 * well centered", which defocus cannot fix anyway.
 */

export interface QuickFocusOptions {
  /** Rays across the pupil grid at each field and wavelength. */
  gridCount?: number;
  /** Evaluations the search may spend before giving up. */
  budget?: number;
}

export interface QuickFocusOutcome {
  system: OpticalSystem;
  /** The surface whose thickness moved. */
  surfaceIndex: number;
  previousThickness: number;
  thickness: number;
  previousRms: number;
  rms: number;
  evaluations: number;
  /**
   * Fields left out because nothing of them reaches the image at any focus. The
   * focus is still the best one for the rest, but the user should be told which
   * fields it does not speak for.
   */
  droppedFields: readonly number[];
}

/** What one evaluation of the merit saw. */
export interface SpotMerit {
  /** RMS spot radius over the fields that produced an image, in system units. */
  rms: number;
  /** Fields that gave nothing to measure — every ray of them lost before the image. */
  droppedFields: number[];
}

const DEFAULT_GRID_COUNT = 9;
const DEFAULT_BUDGET = 200;
const SCAN_SAMPLES = 21;
/** Relative gain in RMS below which the design is treated as already focused. */
const MEANINGFUL_IMPROVEMENT = 1e-6;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

export function quickFocus(
  system: OpticalSystem,
  options: QuickFocusOptions = {},
): Result<QuickFocusOutcome> {
  return attempt(() => {
    const gridCount = options.gridCount ?? DEFAULT_GRID_COUNT;
    const budget = options.budget ?? DEFAULT_BUDGET;

    const surfaceIndex = system.surfaces.length - 2;
    if (surfaceIndex < 1) {
      throw new RangeError('There is no surface before the image plane to move.');
    }
    const previousThickness = system.surfaceAt(surfaceIndex).thickness;

    let evaluations = 0;
    let droppedFields: readonly number[] = [];
    const merit = (thickness: number): number => {
      evaluations += 1;
      const measured = measureSpot(withThickness(system, surfaceIndex, thickness), gridCount);
      // Which fields have no image does not depend on the thickness being
      // searched — they are vignetted before the image — so the last evaluation's
      // answer describes the whole search.
      droppedFields = measured.droppedFields;
      return measured.rms;
    };

    // Start from wherever the design is; fall back to the paraxial focus when
    // the image sits at infinity, which has no finite thickness to search from.
    const start = Number.isFinite(previousThickness)
      ? previousThickness
      : paraxialThickness(system, surfaceIndex);
    if (start === undefined) {
      throw new RangeError(
        'The image plane is at infinity and the paraxial focus could not be found, so there is nowhere to start.',
      );
    }

    const previousRms = merit(start);
    const found = search(merit, start, budget - evaluations);
    if (found === undefined) {
      throw new RangeError(
        'No image could be measured at any focus: no field has a ray that reaches the image plane. ' +
          'Check the aperture and the fields before focusing.',
      );
    }

    // Only move if the search did meaningfully better. Golden section stops
    // wherever its bracket closed, so re-running from its own answer converges a
    // few parts in a million further along — enough to beat a plain `<`, and to
    // put a visibly identical design on the undo stack every time the button is
    // pressed. Requiring a relative improvement makes a second press a no-op.
    const improved = found.value < previousRms * (1 - MEANINGFUL_IMPROVEMENT);
    const thickness = improved ? found.x : start;
    return {
      system: withThickness(system, surfaceIndex, thickness),
      surfaceIndex,
      previousThickness,
      thickness,
      previousRms,
      rms: improved ? found.value : previousRms,
      evaluations,
      droppedFields,
    };
  });
}

function withThickness(
  system: OpticalSystem,
  surfaceIndex: number,
  thickness: number,
): OpticalSystem {
  return system.withSurfaceAt(surfaceIndex, system.surfaceAt(surfaceIndex).with({ thickness }));
}

/** The thickness that puts the image at the paraxial focus, if that is solvable. */
function paraxialThickness(system: OpticalSystem, surfaceIndex: number): number | undefined {
  const solved = attempt(() => withImageAtParaxialFocus(system));
  if (!solved.ok) {
    return undefined;
  }
  const thickness = solved.value.surfaceAt(surfaceIndex).thickness;
  return Number.isFinite(thickness) ? thickness : undefined;
}

/**
 * The figure of merit: RMS spot radius over every field and wavelength, pooled
 * by ray so that a field losing rays to an aperture cannot quietly outweigh the
 * others.
 *
 * Rays that never arrive are the trap here. Averaging over only the ones that do
 * makes *losing* them look like an improvement: push the image plane far enough
 * and a small detector catches nothing but the axial ray, which sits exactly on
 * the chief ray and scores a flawless zero. So a ray stopped by the image
 * surface's own aperture is charged that aperture's radius — it landed at least
 * that far out, wherever it went — which is enough to stop a blinded system from
 * beating a focused one.
 *
 * A ray that *misses* the image surface is a different failure, and it is not
 * charged but disqualifying — see the note in the loop. Charging it would leave
 * the same hole this paragraph describes: the survivor is the vertex ray, which
 * scores zero, and zero cannot be beaten.
 *
 * Only rays stopped *at the image* are charged. A ray vignetted earlier is lost
 * at every focus, so charging for it adds a constant — and not a small one. An
 * image semi-diameter is tens of millimeters where a spot is tens of microns, so
 * a single interior vignette swamps the measurement it was meant to protect: on
 * one patent file the merit read 14,116 µm against a real spot of 4.0 µm, all of
 * it penalty, and the button appeared to wreck the design it had just focused.
 *
 * A field that contributes nothing either way is dropped and named, rather than
 * making the whole merit infinite and refusing a design whose other fields image
 * perfectly well. That is safe inside a search because such a field is vignetted
 * before the image, and nothing before the image moves when the image plane does
 * — a field the *image* aperture is stopping is not dropped, it is charged. When
 * no field contributes at all the merit is `Infinity` rather than
 * `computeSpot`'s zero, which is an honest average of nothing and a perfect
 * score to a minimizer.
 */
export function measureSpot(system: OpticalSystem, gridCount = DEFAULT_GRID_COUNT): SpotMerit {
  // The detector is finite when it *says* it is: a semi-diameter is how large
  // the image surface is drawn, and only an aperture on it stops a ray. A
  // detector with no aperture catches everything, so there is nothing to charge.
  const image = system.surfaceAt(system.surfaces.length - 1);
  const imageRadius = apertureClearRadius(image.aperture, image.semiDiameter);
  const lostRadius = Number.isFinite(imageRadius) ? imageRadius : undefined;
  const fieldCount = Math.max(system.fields.length, 1);
  const droppedFields: number[] = [];
  let sumSquares = 0;
  let counted = 0;

  for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
    const spot = computeSpot(system, fieldIndex, gridCount);
    // A field the engine refuses outright — one at 90° to the axis, say — is a
    // field with no image, which is the same case as one fully vignetted.
    if (!spot.ok) {
      droppedFields.push(fieldIndex);
      continue;
    }

    // A ray that met the image surface *nowhere* says something different from
    // one its aperture stopped, and it has to be handled before the averaging:
    // this focus position is not a position at all. It happens when the plane
    // lies behind the light — the last surface is curved, so its rim is
    // downstream of its vertex, and a plane at or before that rim is one a ray
    // that already crossed the glass would have to travel backwards to reach.
    //
    // Charging those rays a radius would not do. The trap is that the ray still
    // arriving is the one through the *vertex*, which sits exactly on the chief
    // ray and scores zero — so the merit reads a flawless zero over a single ray
    // and a minimizer takes it every time. Excluding the position outright needs
    // no invented penalty and works whether or not the image has an aperture.
    if (spot.value.missedAtImage > 0) {
      return { rms: Infinity, droppedFields: [] };
    }

    const charged = lostRadius === undefined ? 0 : spot.value.blockedAtImage;
    if (spot.value.traced === 0 && charged === 0) {
      droppedFields.push(fieldIndex);
      continue;
    }

    sumSquares += spot.value.rmsRadius * spot.value.rmsRadius * spot.value.traced;
    counted += spot.value.traced;
    if (lostRadius !== undefined) {
      sumSquares += charged * lostRadius * lostRadius;
      counted += charged;
    }
  }

  // Not `sumSquares > 0`: a perfect image is zero, and an ideal thin lens at
  // exact focus really does make one.
  return { rms: counted > 0 ? Math.sqrt(sumSquares / counted) : Infinity, droppedFields };
}

/** {@link measureSpot} when only the number is wanted. */
export function spotMerit(system: OpticalSystem, gridCount = DEFAULT_GRID_COUNT): number {
  return measureSpot(system, gridCount).rms;
}

/**
 * Finds the thickness of least merit near `start`.
 *
 * Scan first, then refine. The scan is what makes this reliable: the RMS spot
 * against defocus is smooth and single-minimum near focus, but flat far from it
 * — every ray misses by roughly the same amount whichever way you go — so a
 * search that only follows the local slope can sit still on the plateau. If the
 * best sample lands on an edge, the window moves there and widens, which walks
 * the search toward focus from a bad starting guess.
 *
 * Widening can run out without ever bracketing a minimum, and that is not the
 * same as failing. A design whose spot only grows with image distance has its
 * best focus at or before the last surface, where the search is clamped: the
 * answer is the boundary. So the best finite sample seen is kept and returned,
 * and `undefined` now means only what it says — nothing measurable anywhere.
 */
function search(
  merit: (x: number) => number,
  start: number,
  budget: number,
): { x: number; value: number } | undefined {
  let center = start;
  let span = Math.max(Math.abs(start) * 0.02, 1e-6);
  let spent = 0;
  let bestSeen: { x: number; value: number } | undefined;

  for (let widening = 0; widening < 8 && spent < budget; widening += 1) {
    const samples: { x: number; value: number }[] = [];
    for (let i = 0; i < SCAN_SAMPLES && spent < budget; i += 1) {
      const x = Math.max(0, center - span + (2 * span * i) / (SCAN_SAMPLES - 1));
      samples.push({ x, value: merit(x) });
      spent += 1;
    }

    let bestIndex = 0;
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i]!.value < samples[bestIndex]!.value) {
        bestIndex = i;
      }
    }
    const best = samples[bestIndex]!;
    if (!Number.isFinite(best.value)) {
      // Nothing measurable anywhere in the window; widen and look again.
      span *= 4;
      continue;
    }
    if (bestSeen === undefined || best.value < bestSeen.value) {
      bestSeen = best;
    }

    const interior = bestIndex > 0 && bestIndex < samples.length - 1;
    if (interior) {
      const refined = goldenSection(
        merit,
        samples[bestIndex - 1]!.x,
        samples[bestIndex + 1]!.x,
        Math.max(Math.abs(best.x) * 1e-7, 1e-9),
        budget - spent,
      );
      return refined !== undefined && refined.value < best.value ? refined : best;
    }

    // The window is off to one side of the minimum: move onto the best edge and
    // widen, rather than refining a bracket that does not contain a minimum.
    center = best.x;
    span *= 4;
  }
  return bestSeen;
}

/** Golden-section search: no derivatives, and it cannot step outside its bracket. */
function goldenSection(
  merit: (x: number) => number,
  lower: number,
  upper: number,
  tolerance: number,
  budget: number,
): { x: number; value: number } | undefined {
  let a = lower;
  let b = upper;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = merit(c);
  let fd = merit(d);
  let spent = 2;

  while (b - a > tolerance && spent < budget) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = merit(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = merit(d);
    }
    spent += 1;
  }

  const x = fc < fd ? c : d;
  const value = Math.min(fc, fd);
  return Number.isFinite(value) ? { x, value } : undefined;
}
