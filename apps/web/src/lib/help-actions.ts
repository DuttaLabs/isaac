/**
 * Turning what the assistant proposed into an edit of the design — and, first,
 * into a picture of that edit somebody can read before agreeing to it.
 *
 * **The assistant proposes; a person applies.** Everything else it can do is
 * reversible by looking away, and an edit to a prescription is not: a number
 * quietly changed in an engineering document is the one thing here that could
 * cost real work. So this module has two halves, and the order matters — the
 * preview is built first and shown, and nothing calls `applyEdits` until a
 * button is pressed.
 *
 * The application itself goes through `edits.ts` like every other edit in the
 * app, which is what makes a wrong proposal safe rather than merely unlikely:
 * those functions return `Result`, the model validates aggressively, and a
 * refusal comes back as a sentence rather than as a broken system.
 */

import type { OpticalSystem } from '@isaac/optical-core';

import { setMirror, setStop, updateSurface } from './edits.ts';
import type { ProposedEdit } from './help.ts';
import { materialFromText, materialLabel } from './materials.ts';
import { attempt, type Result } from './result.ts';

/** One row of the before-and-after a user reads before pressing Apply. */
export interface EditPreview {
  readonly surface: number;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  /** Set when the edit cannot be made at all, and why. */
  readonly problem?: string;
  /**
   * Something true about the edit that the two columns do not show — a second
   * thing it moves. Kept apart from `problem` because they read oppositely: one
   * says "this will not work", the other says "this will, and here is what else
   * happens", and a reader must be able to tell them apart at a glance.
   */
  readonly note?: string;
}

const LABELS: Record<ProposedEdit['property'], string> = {
  radius: 'Radius',
  conic: 'Conic',
  thickness: 'Thickness',
  semiDiameter: 'Semi-diameter',
  material: 'Material',
  label: 'Label',
  stop: 'Stop',
  mirror: 'Mirror',
};

/** Reads the assistant's text value, allowing `Infinity` where a radius may be one. */
function asNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (/^-?inf(inity)?$/i.test(trimmed)) return trimmed.startsWith('-') ? -Infinity : Infinity;
  const value = Number(trimmed);
  return Number.isNaN(value) ? undefined : value;
}

function asBoolean(text: string): boolean | undefined {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === 'yes' || trimmed === 'on') return true;
  if (trimmed === 'false' || trimmed === 'no' || trimmed === 'off') return false;
  return undefined;
}

/** How a number reads in the grid: trimmed, and `Infinity` spelled out. */
function show(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return String(Number(value.toFixed(6)));
}

/**
 * What each proposed edit would change, before anything is changed.
 *
 * A row that cannot be made carries its reason rather than being dropped: a
 * proposal shown with one line silently missing is a proposal nobody can check
 * against what the assistant said it would do.
 */
export function previewEdits(
  system: OpticalSystem,
  edits: readonly ProposedEdit[],
): readonly EditPreview[] {
  return edits.map((edit) => {
    const label = LABELS[edit.property];
    const out = (
      before: string,
      after: string,
      extra: { problem?: string; note?: string } = {},
    ): EditPreview => ({ surface: edit.surface, label, before, after, ...extra });

    if (edit.surface < 0 || edit.surface >= system.surfaces.length) {
      return out('—', edit.value, { problem: `There is no surface ${edit.surface}.` });
    }
    const surface = system.surfaceAt(edit.surface);

    switch (edit.property) {
      case 'radius':
      case 'conic':
      case 'thickness':
      case 'semiDiameter': {
        const value = asNumber(edit.value);
        const before = show(surface[edit.property]);
        return value === undefined
          ? out(before, edit.value, { problem: `"${edit.value}" is not a number.` })
          : out(before, show(value));
      }
      case 'material': {
        const before = materialLabel(surface.material, surface.reflective);
        const material = materialFromText(edit.value, surface.material);
        return material === undefined
          ? out(before, edit.value, { problem: `No glass called "${edit.value}".` })
          : out(before, materialLabel(material, surface.reflective));
      }
      case 'label':
        return out(surface.comment ?? '—', edit.value === '' ? '—' : edit.value);
      case 'stop': {
        const wanted = asBoolean(edit.value);
        const before = surface.isStop ? 'yes' : 'no';
        return wanted === undefined
          ? out(before, edit.value, { problem: `"${edit.value}" is not yes or no.` })
          : out(before, wanted ? 'yes' : 'no',
              wanted ? {} : { problem: 'A stop is moved by naming the new one, not by clearing this one.' });
      }
      case 'mirror': {
        const wanted = asBoolean(edit.value);
        const before = surface.reflective ? 'yes' : 'no';
        if (wanted === undefined) {
          return out(before, edit.value, { problem: `"${edit.value}" is not yes or no.` });
        }
        // Two things move here, not one, and the second is a surprise if it is
        // not said out loud: making a surface reflect also flips the thickness
        // after it, because otherwise the rest of the design sits where no
        // light goes and every ray comes back MISSED.
        const alsoFlips = wanted !== surface.reflective;
        return out(
          before,
          wanted ? 'yes' : 'no',
          alsoFlips
            ? { note: `Also flips the thickness after it, to ${show(-surface.thickness)}.` }
            : {},
        );
      }
    }
  });
}

/**
 * Applies the lot, or none of it.
 *
 * All-or-nothing because a half-applied proposal is the worst outcome
 * available: the design is then in a state neither the user nor the assistant
 * described, and the undo stack has one entry that undoes only part of it.
 * Each step goes through `edits.ts`, so the first refusal stops the run and
 * comes back in the engine's own words.
 */
export function applyEdits(
  system: OpticalSystem,
  edits: readonly ProposedEdit[],
): Result<OpticalSystem> {
  return attempt(() => {
    let next = system;
    for (const edit of edits) {
      if (edit.surface < 0 || edit.surface >= next.surfaces.length) {
        throw new RangeError(`There is no surface ${edit.surface}.`);
      }
      const surface = next.surfaceAt(edit.surface);
      let step: Result<OpticalSystem>;

      switch (edit.property) {
        case 'radius':
        case 'conic':
        case 'thickness':
        case 'semiDiameter': {
          const value = asNumber(edit.value);
          if (value === undefined) throw new RangeError(`"${edit.value}" is not a number.`);
          step = updateSurface(next, edit.surface, { [edit.property]: value });
          break;
        }
        case 'material': {
          const material = materialFromText(edit.value, surface.material);
          if (material === undefined) throw new RangeError(`No glass called "${edit.value}".`);
          step = updateSurface(next, edit.surface, { material });
          break;
        }
        case 'label':
          step = updateSurface(next, edit.surface, { comment: edit.value });
          break;
        case 'stop': {
          const wanted = asBoolean(edit.value);
          if (wanted !== true) {
            throw new RangeError('A stop is moved by naming the new one, not by clearing the old.');
          }
          step = setStop(next, edit.surface);
          break;
        }
        case 'mirror': {
          const wanted = asBoolean(edit.value);
          if (wanted === undefined) throw new RangeError(`"${edit.value}" is not yes or no.`);
          step = setMirror(next, edit.surface, wanted);
          break;
        }
      }

      if (!step.ok) throw new RangeError(step.error);
      next = step.value;
    }
    return next;
  });
}
