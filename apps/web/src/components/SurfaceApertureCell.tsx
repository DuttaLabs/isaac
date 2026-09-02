import { useEffect, useRef, useState } from 'react';
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
 * **The outer size is fixed and the hole is proportional.** Every circular
 * aperture is drawn as the same disc, obscuration or not, and what varies is the
 * hole — `minRadius / maxRadius` of it, so a big hole looks big and two rings
 * can be compared down the column. Floored and capped, because real designs run
 * off both ends of what a glyph this size can show: a spatial-filter pinhole is
 * a hole too small to draw, and a telescope baffle is often a ring too thin.
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
 * The smallest hole that can be seen, as a radius in the icon's own units.
 *
 * A hole is drawn in proportion — `minRadius / maxRadius` of the disc — and that
 * proportion runs all the way to nothing. **A spatial-filter pinhole is the case
 * that needs a floor**: five microns in a ten-millimetre beam is one part in two
 * thousand, so an aperture whose entire purpose is its hole would draw as a
 * plain disc. Above the floor the proportion is real.
 *
 * A hole of *exactly* zero stays zero. "No hole" and "a hole too small to draw"
 * are different facts, and the icon should not merge them.
 */
const MIN_HOLE = 0.7;

/**
 * The thinnest a ring may be drawn, in the icon's own units — the other end of
 * the same problem.
 *
 * Stated as a *thickness* rather than as a fraction of the disc, because that is
 * the thing that has to stay visible: a ring is legible when there is enough of
 * it to see, whatever radius it sits at. LSST's baffles run to `2390.5–2400.5`,
 * four parts in a thousand thick, which unclamped is a hairline and at some zoom
 * levels nothing at all.
 */
const MIN_RING = 1.4;

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

export function apertureSummary(
  aperture: SurfaceAperture | undefined,
  rollDeg = 0,
  units = '',
): string {
  if (aperture === undefined) {
    return 'No aperture — this surface stops no light';
  }
  const inUnits = units === '' ? '' : ` ${units}`;
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
    (decentered
      ? `, decentered (${aperture.decenterX}${inUnits}, ${aperture.decenterY}${inUnits})`
      : '') + turned;
  if (aperture.kind === 'FLOATING') {
    return `${APERTURE_KIND_LABELS.FLOATING}${where}`;
  }
  // A spider is described by its arms, not by any radius or width. It fell
  // through to the half-width branch and reported "0 × 0 half-widths" — the
  // zeros a normalized spider carries because those fields have no meaning on
  // one.
  if (aperture.kind === 'SPIDER') {
    const arms = aperture.armCount === 1 ? '1 arm' : `${aperture.armCount} arms`;
    return `${APERTURE_KIND_LABELS.SPIDER}, ${arms}, ${aperture.armWidth}${inUnits} wide${where}`;
  }
  if (!isCircularAperture(aperture.kind)) {
    const size = `${aperture.halfWidthX} × ${aperture.halfWidthY}${inUnits} half-widths`;
    return `${APERTURE_KIND_LABELS[aperture.kind]}, ${size}${where}`;
  }
  const ring =
    aperture.minRadius > 0
      ? `${aperture.minRadius}–${aperture.maxRadius}`
      : `${aperture.maxRadius}`;
  return `${APERTURE_KIND_LABELS[aperture.kind]}, radius ${ring}${inUnits}${where}`;
}

/**
 * How big the preview in the dialog is drawn, in pixels.
 *
 * **Its own number, not a multiple of the table's.** The two are separate
 * components on purpose: the table's icon is one of a column of them and may
 * come to size itself against its neighbours, while this one is a single large
 * picture in a box of its own. Tying the preview to `PIXELS` would mean every
 * future change to how the column sizes itself silently resized this too.
 *
 * It also does not follow the development scale knob, which exists to try out
 * row heights and has nothing to say about a dialog.
 */
const PREVIEW_PIXELS = 90;

/**
 * How thin and how thick a vane may be drawn, in the icon's own units.
 *
 * Between them the width is a real proportion — the arm's width against its
 * length — so a heavy strut draws heavier than a fine wire. Outside them it is
 * not, and real files reach both ends.
 *
 * **The floor**, because a spider is typically a hundredth of its aperture
 * across: LSST's arms are 50 wide on a 4800 semi-diameter, which in proportion
 * is a fifteenth of a pixel. Drawn faithfully every spider would be invisible.
 *
 * **The ceiling**, because `sc_spatial3.zmx` carries a vane 2 wide on a surface
 * whose semi-diameter is 2 — as wide as the arm is long. In proportion that is
 * three black bars meeting in the middle, which is a blob rather than a spider.
 * Capped it still reads as much the chunkiest one in the corpus.
 */
const MIN_VANE = 0.9;
const MAX_VANE = DISC * 0.55;

/** Shared geometry for both. See {@link ApertureArtwork}. */
interface ApertureDrawing {
  aperture: SurfaceAperture | undefined;
  color: string;
  /**
   * How far the aperture is turned on its surface — the cumulative z tilt of the
   * coordinate transforms before it, from `apertureRollDegrees`.
   *
   * **The glyph turns and the square does not.** The frame is the icon, not the
   * part; turning it would draw a tilted picture rather than a picture of a
   * tilted thing.
   */
  rollDeg?: number;
  /**
   * How far the surface is drawn out, which is what a decenter is measured
   * against for the two kinds that have no size of their own: a spider, whose
   * whole description is its vanes, and a floating aperture, which *is* the
   * semi-diameter. It also sets a vane's width, being the length of an arm.
   */
  semiDiameter?: number;
}

/**
 * The drawing itself, in the icon's own 18-unit space — everything inside the
 * `<svg>` and nothing about how large it is.
 *
 * **Shared deliberately, while the two components around it are not.** How big a
 * picture is drawn, and what surrounds it, are presentation and the table and
 * the dialog should be free to disagree. *Where a decentered obscuration sits*
 * is not: two drawings of one aperture that disagreed about that would be the
 * same fault as a layout showing an aperture the trace does not have. So the
 * size policy is duplicated and the geometry is not.
 */
function ApertureArtwork({
  aperture,
  color,
  rollDeg = 0,
  semiDiameter = Infinity,
}: ApertureDrawing) {
  if (aperture === undefined) {
    // Not nothing: an empty cell in a column of pictures reads as a missing
    // picture. A faint outline says "there could be one here", which is also
    // the invitation to click.
    return (
      <rect
        x={1.5}
        y={1.5}
        width={SIDE - 3}
        height={SIDE - 3}
        rx={2}
        className="aperture-empty"
        strokeDasharray="2 2"
      />
    );
  }

  const glyph = glyphFor(aperture, semiDiameter);
  const arms =
    aperture.kind === 'SPIDER'
      ? Array.from(
          { length: aperture.armCount },
          (_, arm) => (2 * Math.PI * arm) / aperture.armCount,
        )
      : [];
  /**
   * How wide to draw a vane.
   *
   * An arm runs from the hub out to the rim, so its length on the surface is the
   * semi-diameter and in the icon it is `DISC` — which fixes the scale, and the
   * width follows it. `armWidth` is a full width rather than a half, so it needs
   * no doubling.
   *
   * Held between {@link MIN_VANE} and {@link MAX_VANE}; in practice the floor
   * is what applies, every ordinary spider being far thinner than an icon can
   * show. Between them the proportion is real, so a heavy vane draws heavier
   * than a fine one.
   */
  const surfaceHalf = Number.isFinite(semiDiameter) && semiDiameter > 0 ? semiDiameter : 0;
  const vane =
    surfaceHalf > 0
      ? Math.min(MAX_VANE, Math.max(MIN_VANE, (aperture.armWidth * DISC) / surfaceHalf))
      : MIN_VANE;
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
   * thing worth seeing; the arrow says it was clamped and the tooltip carries
   * the numbers.
   */
  const shift = (
    decenter: number,
    glyphHalf: number,
    systemHalf: number,
  ): { at: number; beyond: number } => {
    if (decenter === 0 || !Number.isFinite(systemHalf) || systemHalf <= 0) {
      return { at: 0, beyond: 0 };
    }
    const wanted = (glyphHalf * decenter) / systemHalf;
    const at = Math.max(-CENTER, Math.min(CENTER, wanted));
    return { at, beyond: Math.sign(wanted - at) };
  };
  const alongX = shift(aperture.decenterX, glyph.rx, glyph.refX);
  const alongY = shift(aperture.decenterY, glyph.ry, glyph.refY);
  const cx = CENTER + alongX.at;
  const cy = CENTER - alongY.at;
  const stopping = isObscuration(aperture.kind);
  /**
   * Which way the aperture ran off, once it has been clamped — `undefined` while
   * the icon is still telling the truth about where it is.
   *
   * Taken *after* the view transform, because that is the direction a reader
   * sees. The clamp happens in the icon's own upright coordinates, and both the
   * mirror and the roll move it: an aperture that overflows the +x side ends up
   * pointing somewhere else entirely once the glyph is turned 45° and flipped.
   */
  const overflow = markerDirection(alongX.beyond, alongY.beyond, rollDeg);
  /**
   * The icon looks at the surface the way the 3-D view's home camera does:
   * **+x to the left, +y up**, from off the −x side. That mirror is the whole
   * of the difference, and it is what makes a right-handed roll about +z read
   * *clockwise* here, as it does in the 3-D picture.
   *
   * The drawing inside is left in ordinary math coordinates — +x right, +y up,
   * a counter-clockwise `rotate` — and mirrored once on the way out. Handedness
   * reverses with the mirror, so the rotation and the decenter turn over
   * together. They have to: LSST's spiders are decentered *and* rolled 45°, and
   * there is no viewpoint with +x right, +y up in which a right-handed roll
   * looks clockwise.
   *
   * Note this is the opposite hand from the 2-D X–Y layout, which looks *back*
   * along the axis from image space and so has +z out of the screen. Both are
   * honest; they are opposite ends of the same lens. The icon follows the 3-D
   * view because that is the picture it sits beside.
   */
  const mirror = `translate(${SIDE} 0) scale(-1 1)`;
  const turn =
    Math.abs(rollDeg) < 1e-9 ? mirror : `${mirror} rotate(${-rollDeg} ${CENTER} ${CENTER})`;

  return (
    <>
      <rect x={0} y={0} width={SIDE} height={SIDE} rx={2} className="aperture-ground" />
      {/* Drawn outside the turned group: it is a mark on the *icon*, pinned to
          the frame, and the direction it points has already been turned. */}
      {overflow === undefined ? null : (
        <polygon className="aperture-overflow" points={overflowArrow(overflow)} />
      )}
      <g transform={turn}>
        {arms.length > 0 ? (
          // Vanes radiating from the hub, the first along +x exactly as the
          // aperture defines them — so a three-armed spider in the icon points the
          // same way it does in the layout. Screen y grows downward, hence the
          // negated sine.
          //
          // From `cx`/`cy` rather than the middle: the vanes are struck from the
          // spider's own center, so a decentered one hangs off to the side the
          // way it really does.
          arms.map((angle, at) => (
            <line
              key={at}
              x1={cx}
              y1={cy}
              x2={cx + DISC * Math.cos(angle)}
              y2={cy - DISC * Math.sin(angle)}
              className="aperture-arm"
              strokeWidth={vane}
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
    </>
  );
}

/**
 * The cell's picture, in the lens table. `color` is the element this surface
 * belongs to, so an aperture is recognisably *on* the mirror or the lens it cuts
 * into.
 *
 * Sized here rather than in the sheet: one place decides how tall an aperture
 * row is, which is why the development knob lives here too.
 */
export function ApertureIcon(props: ApertureDrawing) {
  // In a production build this is `DEFAULT_TWEAKS` and the subscription never
  // fires; the hook is called unconditionally all the same.
  const { apertureIconScale: scale } = useTweaks();
  // The placeholder is smaller, and deliberately does not follow the knob: it
  // marks a surface with *no* aperture, so it should stay quiet however large
  // the real icons are drawn.
  const pixels = props.aperture === undefined ? EMPTY_PIXELS : PIXELS * scale;

  return (
    <svg
      className={props.aperture === undefined ? 'aperture-icon empty' : 'aperture-icon'}
      style={{ width: `${pixels}px`, height: `${pixels}px` }}
      viewBox={`0 0 ${SIDE} ${SIDE}`}
      aria-hidden="true"
    >
      <ApertureArtwork {...props} />
    </svg>
  );
}

/**
 * The same aperture, large, at the top of the editing dialog.
 *
 * A separate component from {@link ApertureIcon} rather than a prop on it: they
 * share a drawing and nothing else. This one is a single picture in a box of its
 * own at a fixed size, and it keeps that size when the aperture is `None` so the
 * dialog does not jump as the type is changed.
 */
export function AperturePreview(props: ApertureDrawing) {
  return (
    <svg
      className="aperture-preview-icon"
      style={{ width: `${PREVIEW_PIXELS}px`, height: `${PREVIEW_PIXELS}px` }}
      viewBox={`0 0 ${SIDE} ${SIDE}`}
      aria-hidden="true"
    >
      <ApertureArtwork {...props} />
    </svg>
  );
}

/** How far the overflow arrow reaches, and how far in from the frame it sits. */
const MARK = 3;
const MARK_INSET = 0.6;

/**
 * Which way a clamped aperture ran off, as a unit direction **on screen** —
 * `undefined` when nothing was clamped.
 *
 * `bx` and `by` are the signs of the overflow in the icon's own upright
 * coordinates, where y runs up. Both of the view's transforms have to be applied
 * to get the direction a reader actually sees, and in the order the group
 * applies them: the roll first, then the mirror.
 */
function markerDirection(
  bx: number,
  by: number,
  rollDeg: number,
): { x: number; y: number } | undefined {
  if (bx === 0 && by === 0) {
    return undefined;
  }
  // Into SVG's own frame, where y grows downward.
  const vx = bx;
  const vy = -by;
  // The group turns by `-rollDeg`, and SVG's positive rotation is clockwise.
  const angle = (-rollDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Then the mirror, which negates x and leaves y alone.
  const x = -(vx * cos - vy * sin);
  const y = vx * sin + vy * cos;
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

/**
 * The arrow itself: a small triangle with its point on the frame, aimed out.
 *
 * Placed where a ray from the middle of the icon in that direction meets the
 * square — so it lands mid-edge for a straight overflow and in the corner for a
 * diagonal one, which is where the reader's eye already is.
 */
function overflowArrow(direction: { x: number; y: number }): string {
  const reach =
    (CENTER - MARK_INSET) / Math.max(Math.abs(direction.x), Math.abs(direction.y), 1e-9);
  const tipX = CENTER + direction.x * reach;
  const tipY = CENTER + direction.y * reach;
  const backX = tipX - direction.x * MARK;
  const backY = tipY - direction.y * MARK;
  // Across the arrow, to put the two base corners either side of it.
  const acrossX = -direction.y * MARK * 0.6;
  const acrossY = direction.x * MARK * 0.6;
  return [
    `${tipX},${tipY}`,
    `${backX + acrossX},${backY + acrossY}`,
    `${backX - acrossX},${backY - acrossY}`,
  ].join(' ');
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
function glyphFor(
  aperture: SurfaceAperture,
  semiDiameter: number,
): {
  rx: number;
  ry: number;
  refX: number;
  refY: number;
  rectangular: boolean;
  hole: number;
} {
  const stopping = isObscuration(aperture.kind);
  /**
   * **One outer size for everything, aperture and obscuration alike.**
   *
   * An obscuration used to be drawn at half this, on the grounds that it is a
   * thing *in the way* of a surface rather than the bound of one, and so has no
   * outer bound in the icon to be a proportion of. True, but it cost more than
   * it bought: at half size an annular obscuration had half the room to show its
   * ring, and LSST's seven baffles — several far thinner than a sixth of their
   * own radius — were all reduced to the same token band.
   *
   * Drawn at an aperture's size the ring has the room, and the column gains a
   * simpler rule: every circular aperture is the same disc, and what varies is
   * the hole and the ink. The cost is that a *solid* obscuration is now a large
   * black disc rather than a small one, which is the honest reading — the icon
   * has never claimed to say what fraction of a surface is covered.
   */
  const full = DISC;
  const rectangular =
    aperture.kind === 'RECTANGULAR' || aperture.kind === 'RECTANGULAR_OBSCURATION';
  /** The fallback reference for a kind with no half-size of its own. */
  const surface = Number.isFinite(semiDiameter) && semiDiameter > 0 ? semiDiameter : 0;

  if (aperture.kind === 'SPIDER') {
    // Drawn as lines rather than as a region, so the glyph carries only the
    // reference the decenter is measured against — and that has to be the
    // *surface*, since a spider has no size but its vanes. `DISC` is the reach
    // of an arm, which is what the hub's offset is read against.
    return { rx: DISC, ry: DISC, refX: surface, refY: surface, rectangular: false, hole: 0 };
  }

  if (isCircularAperture(aperture.kind)) {
    // A floating aperture has no radius of its own: it *is* the semi-diameter,
    // so that is what its decenter is measured against.
    const outer = Number.isFinite(aperture.maxRadius) ? aperture.maxRadius : surface;
    /**
     * An annulus, whichever way it reads. A `CIRCULAR` aperture passes light
     * between the two radii and a `CIRCULAR_OBSCURATION` stops it there — both
     * are a *ring*, and only the ink differs.
     *
     * Held between a smallest hole and a thinnest ring, and real designs reach
     * both ends: a spatial-filter pinhole is a hole too small to draw, and a
     * telescope baffle is often a ring too thin. Between them the proportion is
     * real, which is what makes a column of them comparable — LSST's surfaces 23
     * and 26 differ by exactly the amount their radii do.
     *
     * Zero stays zero, so a plain disc is still a plain disc. The outer bound is
     * `Math.max(..., MIN_HOLE)` so the two limits cannot cross and invert if the
     * disc is ever made smaller than the sum of them.
     */
    const hole =
      aperture.minRadius > 0 && outer > 0
        ? Math.min(
            Math.max(full - MIN_RING, MIN_HOLE),
            Math.max(MIN_HOLE, (full * aperture.minRadius) / outer),
          )
        : 0;
    return {
      rx: full,
      ry: full,
      refX: outer,
      refY: outer,
      rectangular: false,
      hole,
    };
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
  color,
  rollDeg,
  onCommit,
  onClose,
}: {
  surfaceLabel: string;
  aperture: SurfaceAperture | undefined;
  /** Shown beside a floating aperture, which is defined as this number. */
  semiDiameter: number;
  units: string;
  /** The element's color, so the preview is the same picture the table shows. */
  color: string;
  /** The cumulative roll from the coordinate transforms before this surface. */
  rollDeg: number;
  onCommit: (next: SurfaceAperture | undefined) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  /**
   * Whether the preview shows the aperture where the *system* puts it, or in its
   * own frame.
   *
   * Off by default, and that is the useful default: the numbers below are the
   * aperture's own, stated in the surface's own frame, so an editor showing them
   * turned by something written three surfaces earlier would be answering a
   * different question from the one being asked. Switched on it becomes the
   * table's icon exactly, which is how you check that the two agree.
   */
  const [inSystem, setInSystem] = useState(false);
  const turned = Math.abs(rollDeg) > 1e-9;

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

    /**
     * Only a kind that is *bounded* by half-widths has any to carry across.
     *
     * A spider is neither family — it is described by its arms — so a normalized
     * one carries `halfWidthX: 0`, and those zeros used to be carried straight
     * into the new aperture. `??` catches only null and undefined, so `0 ??
     * fallback` is `0`, and `normalizeAperture` rightly threw: a rectangle with
     * no width is not a rectangle. The throw came out of the change handler, so
     * picking "Rectangular" while a spider was selected simply did nothing.
     */
    const sized =
      aperture !== undefined && !isCircularAperture(aperture.kind) && aperture.kind !== 'SPIDER';
    const carriedX = sized && aperture.halfWidthX > 0 ? aperture.halfWidthX : undefined;
    const carriedY = sized && aperture.halfWidthY > 0 ? aperture.halfWidthY : undefined;
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

      {/* The picture rather than a paragraph about it. The dialog is opened *from*
          this icon, so the thing a reader is looking for is the same picture
          larger — and it follows every edit below, which no sentence can. */}
      <div className="aperture-preview">
        <AperturePreview
          aperture={aperture}
          color={color}
          semiDiameter={semiDiameter}
          rollDeg={inSystem ? rollDeg : 0}
        />
        <label className={turned ? 'aperture-inline' : 'aperture-inline unavailable'}>
          <input
            type="checkbox"
            checked={inSystem && turned}
            disabled={!turned}
            aria-label={`Show the aperture of surface ${surfaceLabel} as the coordinate transforms leave it`}
            onChange={(event) => setInSystem(event.target.checked)}
          />
          <span
            title={
              turned
                ? `The coordinate transforms before this surface turn it ${Math.round(rollDeg * 1000) / 1000}°.`
                : 'No coordinate transform turns this surface.'
            }
          >
            Include preceding coordinate transform
          </span>
        </label>
      </div>

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
