import { type PanelId } from './panels.ts';
import { type ViewPlaneId } from './view-plane.ts';

/**
 * What one panel on screen is set to, as distinct from what every copy of it
 * shows.
 *
 * The rule these follow is **input mirrors, output differs**. A panel showing
 * the design — the source object, the lens grid — must read the same in every
 * copy, because there is one design and two views of it disagreeing about it
 * would be a lie. A panel showing a *picture of* the design has no such duty: a
 * second Layout 2D exists precisely so it can be turned to a different plane
 * than the first, and holding "which plane" in one place for the whole app is
 * what made that impossible.
 *
 * So these live on the pane rather than on `App`. Two consequences fall out of
 * that one move, and both are the point:
 *
 * - Two copies of an output panel are independent without anything keeping them
 *   apart, because they are reading different objects.
 * - Saving the arrangement saves these too, for free, since they are *inside*
 *   the tree that gets saved. A layout that reopens with the panels in the right
 *   places but every plot back at its default would not be the layout that was
 *   saved.
 *
 * A **setting** is something worth reopening with. A *signal* — a Reset-view
 * counter, a hover highlight — is not, and stays on `App`: writing a reset
 * counter to disk would mean nothing on the way back in.
 */

/** Quarter turns clockwise applied to a plot: 0, 90, 180 or 270 degrees. */
export type QuarterTurns = 0 | 1 | 2 | 3;

/**
 * Which fields a plot draws, as a flag per field.
 *
 * It **narrows** the Source panel's own Display column rather than replacing it:
 * that column says which fields are in play at all, and this says which of those
 * this one picture is showing. A field switched off in Source is off everywhere;
 * one switched off here is off in this plot alone.
 *
 * Short arrays read as visible past their end — the same `?? true` idiom the
 * Source column already uses — so a design gaining a field does not need every
 * plot's list rewritten, and one losing a field leaves no stale flags behind.
 */
export type FieldFlags = readonly boolean[];

interface PlotSettings {
  /** How many rays across a fan this plot traces. */
  readonly raysPerFan: number;
  /** Every wavelength, or the primary one alone. */
  readonly allWavelengths: boolean;
  readonly fields: FieldFlags;
}

export interface Layout2DSettings extends PlotSettings {
  readonly panel: 'layout2d';
  readonly plane: ViewPlaneId;
  /**
   * How far the drawing is turned. A quarter turn puts the object at the top and
   * the image at the bottom, which is how a microscope's column is read; a half
   * turn sends the light right to left.
   */
  readonly quarterTurns: QuarterTurns;
  /** The marginal and chief rays, and the pupils they define. */
  readonly showFirstOrder: boolean;
}

/**
 * Where the camera stands, once the user has put it somewhere.
 *
 * A *setting*, not a signal, and the distinction earns its keep here: an
 * orientation someone set up by hand is exactly the kind of thing that should
 * still be there when they come back, and keeping it on the pane is what makes
 * it survive both a re-render and — the case that actually bit — closing the
 * panel next door, which remounts this one and takes every scrap of component
 * state with it.
 *
 * Written on the *end* of a drag rather than per frame: an orbit is one gesture
 * however many frames it takes, and a write per frame would re-render the app
 * sixty times a second to record something nobody has finished doing.
 */
export interface CameraState {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /** Orthographic size, and 1 on a perspective camera that has not been zoomed. */
  readonly zoom: number;
}

export interface Layout3DSettings extends PlotSettings {
  readonly panel: 'layout3d';
  /** Undefined until the view has been framed by hand; Reset view clears it. */
  readonly camera?: CameraState;
}

/**
 * A plot taken at one field rather than across several, so it names the field
 * instead of filtering a list of them. `fields` is inherited and unused here;
 * the single-field plots read `field`.
 */
interface SingleFieldSettings {
  /** Which field this plot is taken at. */
  readonly field: number;
  readonly raysPerFan: number;
  readonly allWavelengths: boolean;
}

export interface RayFanSettings extends SingleFieldSettings {
  readonly panel: 'rayFan';
}

export interface SpotSettings extends SingleFieldSettings {
  readonly panel: 'spot';
}

export type PanelSettings = Layout2DSettings | Layout3DSettings | RayFanSettings | SpotSettings;

export const DEFAULT_LAYOUT_2D: Layout2DSettings = {
  panel: 'layout2d',
  plane: 'YZ',
  quarterTurns: 0,
  raysPerFan: 9,
  allWavelengths: false,
  showFirstOrder: false,
  fields: [],
};

export const DEFAULT_LAYOUT_3D: Layout3DSettings = {
  panel: 'layout3d',
  raysPerFan: 9,
  allWavelengths: false,
  fields: [],
};

export const DEFAULT_RAY_FAN: RayFanSettings = {
  panel: 'rayFan',
  field: 0,
  raysPerFan: 21,
  allWavelengths: false,
};

export const DEFAULT_SPOT: SpotSettings = {
  panel: 'spot',
  field: 0,
  // A spot is a grid, so this is its side: 15 across the pupil is ~177 rays
  // inside the rim, which is dense enough to read a shape from.
  raysPerFan: 15,
  allWavelengths: false,
};

/**
 * What a panel starts with, or `undefined` for one that has nothing to set.
 *
 * The panels with no entry here are the input ones and the First order table:
 * every copy of them shows the same thing, so there is nothing for a copy to
 * hold of its own.
 */
export function defaultSettings(panel: PanelId): PanelSettings | undefined {
  switch (panel) {
    case 'layout2d':
      return DEFAULT_LAYOUT_2D;
    case 'layout3d':
      return DEFAULT_LAYOUT_3D;
    case 'rayFan':
      return DEFAULT_RAY_FAN;
    case 'spot':
      return DEFAULT_SPOT;
    default:
      return undefined;
  }
}

/**
 * Settings read back with every missing value filled in.
 *
 * Merged onto the defaults rather than trusted whole, which is what makes a
 * stored layout survive Isaac growing a new setting: an older one simply lacks
 * the key and takes the default. Settings belonging to a *different* panel are
 * discarded outright — that is a pane whose panel was changed, or a saved layout
 * repaired on the way in, and neither has anything to say about this one.
 */
export function settingsOf<T extends PanelSettings>(
  stored: PanelSettings | undefined,
  fallback: T,
): T {
  return stored !== undefined && stored.panel === fallback.panel
    ? { ...fallback, ...stored }
    : fallback;
}

/** Whether a field is drawn in this plot, reading past the end as visible. */
export function fieldShown(fields: FieldFlags, index: number): boolean {
  return fields[index] ?? true;
}

/** The same list with one field turned on or off, padded out to reach it. */
export function withFieldShown(fields: FieldFlags, index: number, shown: boolean): FieldFlags {
  const next = [...fields];
  while (next.length <= index) {
    next.push(true);
  }
  next[index] = shown;
  return next;
}
