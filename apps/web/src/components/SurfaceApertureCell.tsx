import { useEffect, useRef } from 'react';
import type { ApertureKind, SurfaceAperture } from '@isaac/optical-core';
import { useTweaks } from '../dev/tweaks.ts';
import { NumericCell } from './NumericCell.tsx';

/**
 * A surface's aperture: the icon that stands for it in the lens table, and the
 * dialog that edits it.
 *
 * **The icon is a picture of the part, not a transmission map.** White is empty
 * space, a colored disc is the surface itself, and a black disc is something
 * put in the way — so the Hubble's primary reads as a mirror with a hole down
 * the middle, and its baffle as a small disc hanging in front of the light.
 * The other reading (white means light passes) is defensible and would invert
 * every icon; this one is what a designer sees when they look at the hardware,
 * which is what makes a whole column of them scannable.
 *
 * Sizes are proportional where a proportion means something — the hole in an
 * annulus is `minRadius / maxRadius` of the disc, so a big hole looks big — and
 * fixed where the drawing has no outer bound to be proportional to.
 */

/** The icon's own coordinate space. Screen size is {@link PIXELS}. */
const SIDE = 18;
const CENTER = SIDE / 2;
/**
 * How large the icon is drawn, before the development scale knob. Every pixel
 * here is a pixel of row height, which is why the knob exists — see
 * `dev/tweaks.ts`.
 */
const PIXELS = 36;
/**
 * The placeholder's size, which the knob does not touch. It marks a surface
 * with *no* aperture, so it should stay quiet however large the real icons are.
 */
const EMPTY_PIXELS = 18;
/** The disc standing for the surface itself, nearly filling the square. */
const DISC = 0.4 * SIDE;
/**
 * The obscuration.
 *
 * **A fixed size, not a proportion.** Unlike the hole in an annulus — which is
 * `minRadius / maxRadius` of the disc, and so tells you at a glance how much of
 * the aperture is missing — an obscuration has no outer bound *in the icon* to
 * be a proportion of. The nearest candidate is the surface's semi-diameter, and
 * on the case this was drawn for it is the same number (the Hubble's baffle is
 * drawn at exactly its own radius), so a proportional disc would fill the
 * square and say nothing.
 */
const OBSCURATION = SIDE / 4;

export const APERTURE_KIND_LABELS: Record<ApertureKind, string> = {
  CIRCULAR: 'Circular aperture',
  CIRCULAR_OBSCURATION: 'Circular obscuration',
  FLOATING: 'Floating (semi-diameter)',
};

/** What each kind does, in the one line the dialog and the tooltip both want. */
export const APERTURE_KIND_HINTS: Record<ApertureKind, string> = {
  CIRCULAR: 'Light passes between the two radii and is stopped outside them (Zemax CLAP).',
  CIRCULAR_OBSCURATION: 'Light is stopped between the two radii and passes elsewhere (Zemax OBSC).',
  FLOATING: 'A circular aperture that follows the semi-diameter (Zemax FLAP).',
};

/**
 * Where to draw a decentered obscuration. Its own disc is a fixed size, so the
 * offset is measured against the obscuration's *radius* — a baffle decentered by
 * its own radius sits with its edge on the axis, which is what the icon shows.
 */
function obscurationOffset(decenter: number, radius: number): number {
  if (decenter === 0 || !Number.isFinite(radius) || radius <= 0) {
    return 0;
  }
  const shift = (OBSCURATION * decenter) / radius;
  return Math.max(-CENTER, Math.min(CENTER, shift));
}

export function apertureSummary(aperture: SurfaceAperture | undefined): string {
  if (aperture === undefined) {
    return 'No aperture — this surface stops no light';
  }
  const where =
    aperture.decenterX !== 0 || aperture.decenterY !== 0
      ? `, decentered (${aperture.decenterX}, ${aperture.decenterY})`
      : '';
  if (aperture.kind === 'FLOATING') {
    return `${APERTURE_KIND_LABELS.FLOATING}${where}`;
  }
  const ring =
    aperture.minRadius > 0
      ? `${aperture.minRadius}–${aperture.maxRadius}`
      : `${aperture.maxRadius}`;
  return `${APERTURE_KIND_LABELS[aperture.kind]}, radius ${ring}${where}`;
}

/**
 * The cell's picture. `color` is the element this surface belongs to, so an
 * aperture is recognisably *on* the mirror or the lens it cuts into.
 */
export function ApertureIcon({
  aperture,
  color,
}: {
  aperture: SurfaceAperture | undefined;
  color: string;
}) {
  // In a production build this is `DEFAULT_TWEAKS` and the subscription never
  // fires; the hook is called unconditionally all the same.
  const { apertureIconScale: scale } = useTweaks();

  if (aperture === undefined) {
    // Not nothing: an empty cell in a column of pictures reads as a missing
    // picture. A faint outline says "there could be one here", which is also
    // the invitation to click.
    return (
      <svg
        className="aperture-icon empty"
        // Sized here rather than in the sheet, for the same reason the real icon
        // is: one place decides how big an aperture cell is, and the placeholder
        // deliberately does not follow the knob.
        style={{ width: `${EMPTY_PIXELS}px`, height: `${EMPTY_PIXELS}px` }}
        viewBox={`0 0 ${SIDE} ${SIDE}`}
        aria-hidden="true"
      >
        <rect
          x={1.5}
          y={1.5}
          width={SIDE - 3}
          height={SIDE - 3}
          rx={2}
          className="aperture-empty"
          strokeDasharray="2 2"
        />
      </svg>
    );
  }

  const hole =
    aperture.kind === 'CIRCULAR' && aperture.minRadius > 0
      ? DISC * Math.min(aperture.minRadius / aperture.maxRadius, 0.8)
      : 0;
  /**
   * A decentered aperture is drawn decentered, in the same proportion its radius
   * is: the icon's disc stands for `maxRadius`, so a decenter of half that moves
   * it half a disc across. The whole aperture moves, not only its hole — an
   * off-axis parabola is a circle cut well to one side of the parent's axis, and
   * an icon that drew it centered would say the opposite of the truth.
   *
   * Clamped to the square, because those decenters are routinely larger than the
   * aperture itself (Zemax's off-axis Gregorian is 55 mm cut 100 mm off axis)
   * and a disc drawn faithfully at that distance would be off the icon
   * altogether. Clamped, it sits against the edge it went out of, which is the
   * thing worth seeing; the tooltip carries the numbers.
   */
  const offset = (decenter: number): number =>
    !Number.isFinite(aperture.maxRadius) || aperture.maxRadius <= 0
      ? 0
      : Math.max(-DISC, Math.min(DISC, (DISC * decenter) / aperture.maxRadius));

  return (
    <svg
      className="aperture-icon"
      style={{ width: `${PIXELS * scale}px`, height: `${PIXELS * scale}px` }}
      viewBox={`0 0 ${SIDE} ${SIDE}`}
      aria-hidden="true"
    >
      <rect x={0} y={0} width={SIDE} height={SIDE} rx={2} className="aperture-ground" />
      {aperture.kind === 'CIRCULAR_OBSCURATION' ? (
        <circle
          cx={CENTER + obscurationOffset(aperture.decenterX, aperture.maxRadius)}
          cy={CENTER - obscurationOffset(aperture.decenterY, aperture.maxRadius)}
          r={OBSCURATION}
          className="aperture-obscuration"
        />
      ) : (
        <>
          <circle
            cx={CENTER + offset(aperture.decenterX)}
            cy={CENTER - offset(aperture.decenterY)}
            r={DISC}
            fill={color}
            className="aperture-disc"
            // A floating aperture has no radius of its own — it is wherever the
            // semi-diameter is — so its rim is drawn as one that can move.
            strokeDasharray={aperture.kind === 'FLOATING' ? '2 2' : undefined}
          />
          {hole > 0 ? (
            <circle
              // Screen y grows downward, so a hole decentered toward +y is drawn
              // toward the top of the square — the same way the layout draws it.
              cx={CENTER + offset(aperture.decenterX)}
              cy={CENTER - offset(aperture.decenterY)}
              r={hole}
              className="aperture-hole"
            />
          ) : null}
        </>
      )}
    </svg>
  );
}

/**
 * The editor, in a modal for the same reason the aspheric terms are: five more
 * columns for numbers that are set once would push radius, thickness and glass
 * off the side of the screen.
 *
 * Editing is live — every committed field produces a new system, so the layout
 * and the plots follow along behind the open dialog and Undo steps back through
 * the changes one at a time.
 */
export function SurfaceApertureDialog({
  surfaceLabel,
  aperture,
  semiDiameter,
  units,
  onCommit,
  onClose,
}: {
  surfaceLabel: string;
  aperture: SurfaceAperture | undefined;
  /** Shown beside a floating aperture, which is defined as this number. */
  semiDiameter: number;
  units: string;
  onCommit: (next: SurfaceAperture | undefined) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) {
      element.showModal();
    }
  }, []);

  const kind = aperture?.kind;
  /**
   * Changing the type keeps the radii, so trying an obscuration against an
   * aperture is one click each way rather than a retyping exercise. A floating
   * one drops them, because it has none — the model refuses a radius on it.
   */
  const setKind = (next: ApertureKind | 'NONE'): void => {
    if (next === 'NONE') {
      onCommit(undefined);
      return;
    }
    if (next === 'FLOATING') {
      onCommit({
        kind: 'FLOATING',
        minRadius: 0,
        maxRadius: Infinity,
        decenterX: aperture?.decenterX ?? 0,
        decenterY: aperture?.decenterY ?? 0,
      });
      return;
    }
    const maxRadius =
      aperture !== undefined && Number.isFinite(aperture.maxRadius) && aperture.maxRadius > 0
        ? aperture.maxRadius
        : Number.isFinite(semiDiameter)
          ? semiDiameter
          : 1;
    onCommit({
      kind: next,
      minRadius: Math.min(aperture?.minRadius ?? 0, maxRadius / 2),
      maxRadius,
      decenterX: aperture?.decenterX ?? 0,
      decenterY: aperture?.decenterY ?? 0,
    });
  };

  const change = (part: Partial<SurfaceAperture>): void => {
    if (aperture === undefined) {
      return;
    }
    onCommit({ ...aperture, ...part });
  };

  const floating = kind === 'FLOATING';
  const none = aperture === undefined;

  return (
    <dialog
      ref={dialog}
      className="aperture-dialog"
      aria-label={`Aperture of surface ${surfaceLabel}`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          dialog.current?.close();
        }
      }}
    >
      <header>
        <h2>Aperture · surface {surfaceLabel}</h2>
        <button className="subtle" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </header>

      <p className="hint">
        What stops light at this surface. A surface with no aperture stops none, however far off
        axis it is met — the semi-diameter says how large to <em>draw</em> it, not where the light
        ends.
      </p>

      <label className="aperture-field">
        <span>Type</span>
        <select
          value={kind ?? 'NONE'}
          aria-label={`Aperture type of surface ${surfaceLabel}`}
          onChange={(event) => setKind(event.target.value as ApertureKind | 'NONE')}
        >
          <option value="NONE">None</option>
          {(Object.keys(APERTURE_KIND_LABELS) as ApertureKind[]).map((option) => (
            <option key={option} value={option}>
              {APERTURE_KIND_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
      <p className="hint aperture-explainer">
        {kind === undefined ? 'Nothing is stopped here.' : APERTURE_KIND_HINTS[kind]}
      </p>

      <div className="aperture-grid">
        <label className="aperture-field">
          <span>Min radius ({units})</span>
          <NumericCell
            value={none || floating ? 0 : aperture.minRadius}
            disabled={none || floating}
            ariaLabel={`Aperture minimum radius of surface ${surfaceLabel}`}
            onCommit={(next) => change({ minRadius: next })}
          />
        </label>
        <label className="aperture-field">
          <span>Max radius ({units})</span>
          <NumericCell
            value={floating ? semiDiameter : none ? 0 : aperture.maxRadius}
            disabled={none || floating}
            ariaLabel={`Aperture maximum radius of surface ${surfaceLabel}`}
            onCommit={(next) => change({ maxRadius: next })}
          />
        </label>
        <label className="aperture-field">
          <span>Decenter X ({units})</span>
          <NumericCell
            value={none ? 0 : aperture.decenterX}
            disabled={none}
            ariaLabel={`Aperture decenter X of surface ${surfaceLabel}`}
            onCommit={(next) => change({ decenterX: next })}
          />
        </label>
        <label className="aperture-field">
          <span>Decenter Y ({units})</span>
          <NumericCell
            value={none ? 0 : aperture.decenterY}
            disabled={none}
            ariaLabel={`Aperture decenter Y of surface ${surfaceLabel}`}
            onCommit={(next) => change({ decenterY: next })}
          />
        </label>
      </div>

      {floating ? (
        <p className="hint">
          A floating aperture has no radius of its own: it is the semi-diameter, and follows it.
        </p>
      ) : null}

      <footer>
        <button onClick={() => dialog.current?.close()}>Done</button>
      </footer>
    </dialog>
  );
}
