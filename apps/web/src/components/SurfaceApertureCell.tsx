import { useEffect, useRef } from 'react';
import type { ApertureKind, SurfaceAperture } from '@isaac/optical-core';
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

const SIDE = 18;
const CENTER = SIDE / 2;
/** The disc standing for the surface itself, nearly filling the square. */
const DISC = 0.4 * SIDE;
/**
 * The obscuration, inscribed in the square: the corners stay white, so it still
 * reads as a disc on paper rather than as a black cell. It is deliberately
 * larger than {@link DISC} — an obscuration is the whole of what the icon has to
 * say, where the colored disc is a surface that also has a hole to show.
 */
const OBSCURATION = SIDE / 2;

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
  if (aperture === undefined) {
    // Not nothing: an empty cell in a column of pictures reads as a missing
    // picture. A faint outline says "there could be one here", which is also
    // the invitation to click.
    return (
      <svg className="aperture-icon empty" viewBox={`0 0 ${SIDE} ${SIDE}`} aria-hidden="true">
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

  return (
    <svg className="aperture-icon" viewBox={`0 0 ${SIDE} ${SIDE}`} aria-hidden="true">
      <rect x={0} y={0} width={SIDE} height={SIDE} rx={2} className="aperture-ground" />
      {aperture.kind === 'CIRCULAR_OBSCURATION' ? (
        <circle cx={CENTER} cy={CENTER} r={OBSCURATION} className="aperture-obscuration" />
      ) : (
        <>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={DISC}
            fill={color}
            className="aperture-disc"
            // A floating aperture has no radius of its own — it is wherever the
            // semi-diameter is — so its rim is drawn as one that can move.
            strokeDasharray={aperture.kind === 'FLOATING' ? '2 2' : undefined}
          />
          {hole > 0 ? <circle cx={CENTER} cy={CENTER} r={hole} className="aperture-hole" /> : null}
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
