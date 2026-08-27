/**
 * Live knobs for the handful of values that can only be settled by looking at
 * them — how much you see through a lens, how much perspective the 3-D camera
 * has. No amount of reasoning picks those; you turn them until the picture is
 * right.
 *
 * **This is a development tool and is not in the production build.** The panel
 * that drives it (`TweakPanel.tsx`, and `lil-gui` with it) is imported only
 * behind `import.meta.env.DEV`, which Vite replaces with a literal `false` when
 * building, so the branch and everything it reaches are dropped. What ships is
 * this file's `DEFAULT_TWEAKS` and a store nothing ever writes to.
 *
 * So the workflow is: turn the knobs, settle on numbers, and **paste them into
 * `DEFAULT_TWEAKS`** — the panel's *Copy values* button writes them out in the
 * shape of this record for exactly that. The tweak is the experiment; the
 * default is the result.
 *
 * Nothing here may become a user-facing setting by accident. A knob that turns
 * out to be worth keeping graduates to real UI — a control in a panel, on
 * `App` view state — rather than staying behind a dev flag that ships as its
 * frozen default.
 */

import { useSyncExternalStore } from 'react';

export interface Tweaks {
  /** A lens body. The value that started this: 0.42 reads as too see-through. */
  elementOpacity: number;
  /** An element whose surfaces cross, drawn in the fault color. */
  crossedElementOpacity: number;
  /** A bare surface — one with no glass behind it to be the wall of. */
  surfaceOpacity: number;
  /** The image plane, held back so the spot on it stays readable. */
  imageSurfaceOpacity: number;
  /** A ray that reached the image. */
  rayOpacity: number;
  /** A ray stopped by an aperture: present, but not competing with the others. */
  blockedRayOpacity: number;
  /** The optical axis the system sits on. */
  axisOpacity: number;

  /**
   * Perspective or orthographic. Orthographic is the limit of the vertical
   * field of view going to zero with the camera retreating to keep the subject
   * the same size, so the two knobs below are the same knob as this one, read
   * either side of that limit.
   */
  projection: 'perspective' | 'orthographic';
  /**
   * Vertical field of view, in degrees. **Only meaningful together with the
   * refit**: the camera's distance is computed *from* this, so turning it down
   * pulls the camera back and flattens the perspective while the system stays
   * the same size on screen. Change it without the refit and all you have done
   * is zoom.
   */
  fieldOfView: number;
  /** Breathing room around the system once it is fitted. */
  fitMargin: number;
  /**
   * Where the camera stands, as a multiple of the distance the fit chose. 1 is
   * the fit; 2 is twice as far off, with the system half the size on screen and
   * the perspective correspondingly flatter.
   *
   * It multiplies the same number `fitMargin` does, and the two are kept apart
   * because they are asked for differently: a margin is how much air to leave
   * when framing, and is obeyed by the orthographic fit too, while this is a
   * deliberate step backwards from wherever that landed. **Orthographically it
   * changes nothing you can see** — size there is zoom, not distance — and only
   * moves the depth range.
   */
  cameraDistance: number;
}

export const DEFAULT_TWEAKS: Tweaks = {
  elementOpacity: 0.42,
  crossedElementOpacity: 0.55,
  surfaceOpacity: 0.66,
  imageSurfaceOpacity: 0.5,
  rayOpacity: 0.7,
  blockedRayOpacity: 0.16,
  axisOpacity: 0.55,

  projection: 'perspective',
  fieldOfView: 24,
  fitMargin: 1.12,
  cameraDistance: 1,
};

/**
 * The store: a value and a set of listeners, which is all `useSyncExternalStore`
 * asks for. A module-level store rather than props threaded down from `App`,
 * because the alternative is a production component signature carrying
 * development-only parameters — and the thing being tweaked is five levels down
 * inside a canvas.
 */
let current: Tweaks = DEFAULT_TWEAKS;
const listeners = new Set<() => void>();

export function currentTweaks(): Tweaks {
  return current;
}

export function setTweaks(next: Tweaks): void {
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeTweaks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What a component reads. In a production build nothing ever calls `setTweaks`,
 * so this is `DEFAULT_TWEAKS` and the subscription never fires — the hook is
 * called unconditionally all the same, because a hook behind an `if` is a hook
 * behind an `if` however constant the condition looks.
 */
export function useTweaks(): Tweaks {
  return useSyncExternalStore(subscribeTweaks, currentTweaks, currentTweaks);
}

/**
 * The current values written out as the source they are destined to become, so
 * settling on a number is a copy and a paste rather than a transcription. Keys
 * come from `DEFAULT_TWEAKS` so a knob added there cannot be missed here.
 */
export function formatTweaks(values: Tweaks): string {
  const lines = (Object.keys(DEFAULT_TWEAKS) as (keyof Tweaks)[]).map((key) => {
    const value = values[key];
    return `  ${key}: ${typeof value === 'string' ? `'${value}'` : value},`;
  });
  return `export const DEFAULT_TWEAKS: Tweaks = {\n${lines.join('\n')}\n};\n`;
}
