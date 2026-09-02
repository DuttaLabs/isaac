import { useEffect, useRef } from 'react';
import {
  isCircularAperture,
  isObscuration,
  normalizeAperture,
  type ApertureKind,
  type SurfaceAperture,
} from '@isaac/optical-core';
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
  RECTANGULAR: 'Rectangular aperture',
  RECTANGULAR_OBSCURATION: 'Rectangular obscuration',
  ELLIPTICAL: 'Elliptical aperture',
  ELLIPTICAL_OBSCURATION: 'Elliptical obscuration',
  SPIDER: 'Spider',
  FLOATING: 'Floating (semi-diameter)',
};

/** What each kind does, in the one line the dialog and the tooltip both want. */
export const APERTURE_KIND_HINTS: Record<ApertureKind, string> = {
  CIRCULAR: 'Light passes between the two radii and is stopped outside them (Zemax CLAP).',
  CIRCULAR_OBSCURATION: 'Light is stopped between the two radii and passes elsewhere (Zemax OBSC).',
  RECTANGULAR: 'Light passes inside the rectangle and is stopped outside it (Zemax SQAP).',
  RECTANGULAR_OBSCURATION:
    'Light is stopped inside the rectangle and passes outside it (Zemax SQOB).',
  ELLIPTICAL: 'Light passes inside the ellipse and is stopped outside it (Zemax ELAP).',
  ELLIPTICAL_OBSCURATION: 'Light is stopped inside the ellipse and passes outside it (Zemax ELOB).',
  SPIDER: 'Vanes holding a secondary: equal arms at equal angles, the first along +x (Zemax SPID).',
  FLOATING: 'A circular aperture that follows the semi-diameter (Zemax FLAP).',
};

export function apertureSummary(aperture: SurfaceAperture | undefined, rollDeg = 0): string {
  if (aperture === undefined) {
    return 'No aperture — this surface stops no light';
  }
  const decentered = aperture.decenterX !== 0 || aperture.decenterY !== 0;
  /**
   * Said only where it can be seen. A turn is a fact about the surface whatever
   * aperture it carries, but on a centered circle it changes nothing at all, and
   * "turned 45°" against a picture that is identical either way reads as a bug
   * in one of them.
   */
  const turned =
    rollDeg !== 0 && (!isCircularAperture(aperture.kind) || decentered)
      ? `, turned ${Math.round(rollDeg * 1000) / 1000}° by the coordinate breaks before it`
      : '';
  const where =
    (decentered ? `, decentered (${aperture.decenterX}, ${aperture.decenterY})` : '') + turned;
  if (aperture.kind === 'FLOATING') {
    return `${APERTURE_KIND_LABELS.FLOATING}${where}`;
  }
  if (!isCircularAperture(aperture.kind)) {
    const size = `${aperture.halfWidthX} × ${aperture.halfWidthY} half-widths`;
    return `${APERTURE_KIND_LABELS[aperture.kind]}, ${size}${where}`;
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
  rollDeg = 0,
}: {
  aperture: SurfaceAperture | undefined;
  color: string;
  /**
   * How far the aperture is turned on its surface — the cumulative z tilt of the
   * coordinate transforms before it, from `apertureRollDegrees`.
   *
   * **The glyph turns and the square does not.** The frame is the icon, not the
   * part; turning it would draw a tilted picture rather than a picture of a
   * tilted thing. Circular apertures are indifferent to it, apart from where a
   * decenter puts them, which is exactly as it should be.
   */
  rollDeg?: number;
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

  const glyph = glyphFor(aperture);
  const arms =
    aperture.kind === 'SPIDER'
      ? Array.from(
          { length: aperture.armCount },
          (_, arm) => (2 * Math.PI * arm) / aperture.armCount,
        )
      : [];
  /**
   * A decentered aperture is drawn decentered, in the proportion the glyph
   * already stands in: the glyph's half-size is the aperture's half-size, so a
   * decenter of half that moves it half a glyph across. The whole aperture
   * moves, not only its hole — an off-axis parabola is a circle cut well to one
   * side of the parent's axis, and an icon that drew it centered would say the
   * opposite of the truth.
   *
   * Clamped to the square, because those decenters are routinely larger than the
   * aperture itself (Zemax's off-axis Gregorian is 55 mm cut 100 mm off axis)
   * and a glyph drawn faithfully at that distance would be off the icon
   * altogether. Clamped, it sits against the edge it went out of, which is the
   * thing worth seeing; the tooltip carries the numbers.
   */
  const shift = (decenter: number, glyphHalf: number, systemHalf: number): number =>
    decenter === 0 || !Number.isFinite(systemHalf) || systemHalf <= 0
      ? 0
      : Math.max(-CENTER, Math.min(CENTER, (glyphHalf * decenter) / systemHalf));
  const cx = CENTER + shift(aperture.decenterX, glyph.rx, glyph.refX);
  const cy = CENTER - shift(aperture.decenterY, glyph.ry, glyph.refY);
  const stopping = isObscuration(aperture.kind);
  /**
   * Negated because `rollDeg` is counter-clockwise, the model's sense, while
   * SVG's y grows downward and its `rotate` is therefore clockwise. The arms
   * below negate their sine for the same reason.
   */
  const turn = Math.abs(rollDeg) < 1e-9 ? undefined : `rotate(${-rollDeg} ${CENTER} ${CENTER})`;

  return (
    <svg
      className="aperture-icon"
      style={{ width: `${PIXELS * scale}px`, height: `${PIXELS * scale}px` }}
      viewBox={`0 0 ${SIDE} ${SIDE}`}
      aria-hidden="true"
    >
      <rect x={0} y={0} width={SIDE} height={SIDE} rx={2} className="aperture-ground" />
      <g transform={turn}>
        {arms.length > 0 ? (
          // Vanes radiating from the middle, the first along +x exactly as the
          // aperture defines them — so a three-armed spider in the icon points the
          // same way it does in the layout. Screen y grows downward, hence the
          // negated sine.
          arms.map((angle, at) => (
            <line
              key={at}
              x1={CENTER}
              y1={CENTER}
              x2={CENTER + DISC * Math.cos(angle)}
              y2={CENTER - DISC * Math.sin(angle)}
              className="aperture-arm"
            />
          ))
        ) : glyph.rectangular ? (
          <rect
            x={cx - glyph.rx}
            y={cy - glyph.ry}
            width={2 * glyph.rx}
            height={2 * glyph.ry}
            fill={stopping ? undefined : color}
            className={stopping ? 'aperture-obscuration' : 'aperture-disc'}
          />
        ) : (
          <ellipse
            cx={cx}
            cy={cy}
            rx={glyph.rx}
            ry={glyph.ry}
            fill={stopping ? undefined : color}
            className={stopping ? 'aperture-obscuration' : 'aperture-disc'}
            // A floating aperture has no size of its own — it is wherever the
            // semi-diameter is — so its rim is drawn as one that can move.
            strokeDasharray={aperture.kind === 'FLOATING' ? '2 2' : undefined}
          />
        )}
        {glyph.hole > 0 ? (
          <circle cx={cx} cy={cy} r={glyph.hole} className="aperture-hole" />
        ) : null}
      </g>
    </svg>
  );
}

/**
 * The glyph for one aperture: half-sizes in the icon's own units, the aperture
 * half-sizes they stand for, and whether it has corners.
 *
 * **Aspect ratio is kept**, so a 25 by 40 rectangle is drawn taller than it is
 * wide and a square one square — the same reasoning as the hole, whose size is
 * `minRadius / maxRadius` of the disc. What is *not* kept is absolute scale:
 * the larger half-width fills the glyph, because the icon has nothing to be a
 * proportion of but itself.
 *
 * An obscuration is drawn smaller than an aperture, on a fixed size rather than
 * a proportional one: it is a thing in the way rather than the edge of the
 * surface, so there is no outer bound in the icon for it to be measured
 * against.
 */
function glyphFor(aperture: SurfaceAperture): {
  rx: number;
  ry: number;
  refX: number;
  refY: number;
  rectangular: boolean;
  hole: number;
} {
  const stopping = isObscuration(aperture.kind);
  const full = stopping ? OBSCURATION : DISC;
  const rectangular =
    aperture.kind === 'RECTANGULAR' || aperture.kind === 'RECTANGULAR_OBSCURATION';

  if (isCircularAperture(aperture.kind)) {
    const hole =
      aperture.kind === 'CIRCULAR' && aperture.minRadius > 0
        ? full * Math.min(aperture.minRadius / aperture.maxRadius, 0.8)
        : 0;
    return {
      rx: full,
      ry: full,
      refX: aperture.maxRadius,
      refY: aperture.maxRadius,
      rectangular: false,
      hole,
    };
  }

  if (aperture.kind === 'SPIDER') {
    // Drawn as lines rather than as a region, so the glyph carries only the
    // reference the decenter is measured against.
    return { rx: full, ry: full, refX: full, refY: full, rectangular: false, hole: 0 };
  }
  const largest = Math.max(aperture.halfWidthX, aperture.halfWidthY);
  return {
    rx: (full * aperture.halfWidthX) / largest,
    ry: (full * aperture.halfWidthY) / largest,
    refX: aperture.halfWidthX,
    refY: aperture.halfWidthY,
    rectangular,
    // Only a circular aperture has an inner radius; the file format gives the
    // rectangular and elliptical forms no equivalent.
    hole: 0,
  };
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
   * Changing the type keeps the size where the two types measure size the same
   * way, so trying an obscuration against an aperture — or an ellipse against a
   * rectangle — is one click each way rather than a retyping exercise. Crossing
   * between the families cannot carry the numbers across, because a radius and
   * a half-width are different quantities; the new one starts from the surface's
   * own size instead. A floating aperture drops both, having neither.
   */
  const setKind = (next: ApertureKind | 'NONE'): void => {
    if (next === 'NONE') {
      onCommit(undefined);
      return;
    }
    const decenterX = aperture?.decenterX ?? 0;
    const decenterY = aperture?.decenterY ?? 0;
    if (next === 'FLOATING') {
      onCommit(normalizeAperture({ kind: 'FLOATING', decenterX, decenterY })!);
      return;
    }
    // Something to start from when there is nothing to carry over: the surface's
    // own drawn size, or a unit if even that is unset.
    const fallback = Number.isFinite(semiDiameter) && semiDiameter > 0 ? semiDiameter : 1;

    if (next === 'SPIDER') {
      onCommit(
        normalizeAperture({
          kind: 'SPIDER',
          // Three vanes is the commonest real spider, and the width follows the
          // surface rather than starting at something that would cover it.
          armCount:
            aperture?.armCount !== undefined && aperture.armCount > 0 ? aperture.armCount : 3,
          armWidth:
            aperture?.armWidth !== undefined && aperture.armWidth > 0
              ? aperture.armWidth
              : Math.max((Number.isFinite(semiDiameter) ? semiDiameter : 10) / 20, 0.1),
          decenterX,
          decenterY,
        })!,
      );
      return;
    }
    if (isCircularAperture(next)) {
      const carried =
        aperture !== undefined && isCircularAperture(aperture.kind) && aperture.maxRadius > 0
          ? aperture.maxRadius
          : undefined;
      const maxRadius = carried ?? fallback;
      onCommit(
        normalizeAperture({
          kind: next,
          minRadius: Math.min(aperture?.minRadius ?? 0, maxRadius / 2),
          maxRadius,
          decenterX,
          decenterY,
        })!,
      );
      return;
    }

    const carriedX =
      aperture !== undefined && !isCircularAperture(aperture.kind)
        ? aperture.halfWidthX
        : undefined;
    const carriedY =
      aperture !== undefined && !isCircularAperture(aperture.kind)
        ? aperture.halfWidthY
        : undefined;
    onCommit(
      normalizeAperture({
        kind: next,
        halfWidthX: carriedX ?? fallback,
        halfWidthY: carriedY ?? fallback,
        decenterX,
        decenterY,
      })!,
    );
  };

  const change = (part: Partial<SurfaceAperture>): void => {
    if (aperture === undefined) {
      return;
    }
    onCommit({ ...aperture, ...part });
  };

  const floating = kind === 'FLOATING';
  const none = aperture === undefined;
  const spider = kind === 'SPIDER';
  /** Bounded by half-widths rather than radii: a rectangle or an ellipse. */
  const sized = aperture !== undefined && !isCircularAperture(aperture.kind) && !spider;

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

      {/* The two families take different numbers, so the fields follow the type
          rather than sitting there greyed: a rectangle has no radius to give,
          and a row of dead inputs teaches nobody which fields this aperture
          actually has. */}
      <div className="aperture-grid">
        {spider && aperture !== undefined ? (
          <>
            <label className="aperture-field">
              <span>Number of arms</span>
              <NumericCell
                value={aperture.armCount}
                ariaLabel={`Spider arm count of surface ${surfaceLabel}`}
                onCommit={(next) => change({ armCount: Math.max(1, Math.round(next)) })}
              />
            </label>
            <label className="aperture-field">
              <span>Arm width ({units})</span>
              <NumericCell
                value={aperture.armWidth}
                ariaLabel={`Spider arm width of surface ${surfaceLabel}`}
                onCommit={(next) => change({ armWidth: next })}
              />
            </label>
          </>
        ) : sized ? (
          <>
            <label className="aperture-field">
              <span>X half-width ({units})</span>
              <NumericCell
                value={aperture.halfWidthX}
                ariaLabel={`Aperture x half-width of surface ${surfaceLabel}`}
                onCommit={(next) => change({ halfWidthX: next })}
              />
            </label>
            <label className="aperture-field">
              <span>Y half-width ({units})</span>
              <NumericCell
                value={aperture.halfWidthY}
                ariaLabel={`Aperture y half-width of surface ${surfaceLabel}`}
                onCommit={(next) => change({ halfWidthY: next })}
              />
            </label>
          </>
        ) : (
          <>
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
          </>
        )}
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
