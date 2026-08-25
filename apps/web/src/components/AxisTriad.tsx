import type { Axis, ProjectedAxis } from '../lib/view-plane.ts';

export type { ProjectedAxis };

/**
 * The orientation gizmo: X, Y and Z drawn as the viewer sees them, so which way
 * the picture is turned can be read off the picture.
 *
 * An axis lying in the screen is an arrow. An axis pointing *through* the screen
 * has no length to draw and gets the vector convention instead: a circle with a
 * dot when it comes toward you — the tip of the arrow — and a circle with a cross
 * when it goes away, which is the flights at its tail. Nothing is foreshortened
 * or tilted to make the third axis visible; a 2-D view is a 2-D view, and faking
 * a camera angle would draw an orientation the drawing beside it does not have.
 *
 * The component takes axes already projected onto the screen, which is what lets
 * one gizmo serve both layouts: the 2-D view's projection is fixed by its
 * {@link ViewPlane}, and the 3-D view's comes from wherever the user has orbited
 * the camera to.
 */

const LENGTH = 22;
const HEAD = 6;
const HEAD_WIDTH = 2.4;
const LABEL_GAP = 9;
const LABEL_SIZE = 11;
/** Room for a one-letter label around its anchor, and a little air past it. */
const BACKDROP_PAD = 8;

const GLYPH_RADIUS = 6;
const GLYPH_DOT = 1.9;
/** Where the circle's cross reaches: inscribed, so it touches the rim. */
const GLYPH_CROSS = GLYPH_RADIUS * Math.SQRT1_2;

/**
 * Screen length below which an arrow has stopped meaning anything and the glyph
 * is drawn instead — about 12° off the view direction. An axis that close to
 * end-on is a stub whose direction is noise, and the two axes remaining are then
 * within 12° of the screen plane themselves, so they are still full-length
 * arrows: the picture never degenerates into three stubs.
 */
const EDGE_ON = 0.2;

const AXIS_COLOR: Record<Axis, string> = {
  x: 'var(--axis-x)',
  y: 'var(--axis-y)',
  z: 'var(--axis-z)',
};

/** The arrowhead as a triangle sitting on the tip of its shaft. */
function head(tip: { x: number; y: number }, unit: { x: number; y: number }, size: number): string {
  const base = { x: tip.x - unit.x * size, y: tip.y - unit.y * size };
  const width = (size / HEAD) * HEAD_WIDTH;
  const side = { x: -unit.y * width, y: unit.x * width };
  return (
    `${tip.x.toFixed(2)},${tip.y.toFixed(2)} ` +
    `${(base.x + side.x).toFixed(2)},${(base.y + side.y).toFixed(2)} ` +
    `${(base.x - side.x).toFixed(2)},${(base.y - side.y).toFixed(2)}`
  );
}

export function AxisTriad({
  axes,
  label,
  x,
  y,
  scale = 1,
}: {
  axes: readonly ProjectedAxis[];
  /** Lead sentence for the tooltip; the axes through the screen add their own. */
  label: string;
  /** Where the gizmo's origin goes, in the drawing's own coordinates. */
  x: number;
  y: number;
  /** The drawing's current scale, so the gizmo keeps one size on screen. */
  scale?: number;
}) {
  const drawn = axes.map((projected) => {
    const magnitude = Math.hypot(projected.x, projected.y);
    const throughScreen = magnitude < EDGE_ON;
    return {
      ...projected,
      magnitude,
      throughScreen,
      unit: throughScreen
        ? { x: 0, y: 0 }
        : { x: projected.x / magnitude, y: projected.y / magnitude },
    };
  });

  const arrows = drawn.filter((entry) => !entry.throughScreen);
  const glyphs = drawn.filter((entry) => entry.throughScreen);

  // The arrows start clear of the circle when there is one, so the glyph reads as
  // a symbol rather than as a blob the other two axes are stuck through.
  const inner = glyphs.length > 0 ? GLYPH_RADIUS + 2 : 0;

  /**
   * Where a glyph's label goes: opposite every arrow, which is the one direction
   * guaranteed to be free of them. With two arrows at right angles that is the
   * empty quadrant; with none it falls back to straight down.
   */
  const opposite = arrows.reduce(
    (sum, entry) => ({ x: sum.x - entry.unit.x, y: sum.y - entry.unit.y }),
    { x: 0, y: 0 },
  );
  const oppositeLength = Math.hypot(opposite.x, opposite.y);
  const glyphLabelDirection =
    oppositeLength < 1e-9
      ? { x: 0, y: 1 }
      : { x: opposite.x / oppositeLength, y: opposite.y / oppositeLength };

  const placed = drawn.map((entry) => {
    if (entry.throughScreen) {
      return {
        ...entry,
        tip: { x: 0, y: 0 },
        shaft: { x: 0, y: 0 },
        headSize: 0,
        label: {
          x: glyphLabelDirection.x * (GLYPH_RADIUS + LABEL_GAP),
          y: glyphLabelDirection.y * (GLYPH_RADIUS + LABEL_GAP),
        },
      };
    }
    const reach = entry.magnitude * LENGTH;
    const tip = { x: entry.unit.x * reach, y: entry.unit.y * reach };
    // A foreshortened axis must not be given a head longer than its own shaft,
    // which would put the barbs behind the origin and point the arrow backwards.
    const headSize = Math.min(HEAD, (reach - inner) * 0.8);
    return {
      ...entry,
      tip,
      shaft: { x: entry.unit.x * inner, y: entry.unit.y * inner },
      headSize,
      label: {
        x: entry.unit.x * (reach + LABEL_GAP),
        y: entry.unit.y * (reach + LABEL_GAP),
      },
    };
  });

  const labels = placed.map((entry) => entry.label);
  const left = Math.min(0, ...labels.map((point) => point.x)) - BACKDROP_PAD;
  const right = Math.max(0, ...labels.map((point) => point.x)) + BACKDROP_PAD;
  const top = Math.min(0, ...labels.map((point) => point.y)) - BACKDROP_PAD;
  const bottom = Math.max(0, ...labels.map((point) => point.y)) + BACKDROP_PAD;

  const description = glyphs
    .map(
      (entry) =>
        ` ${entry.axis.toUpperCase()} points ` +
        (entry.toward > 0 ? 'out of the screen, toward you.' : 'into the screen, away from you.'),
    )
    .join('');

  return (
    <g className="axis-triad" transform={`translate(${x} ${y}) scale(${scale})`}>
      <title>{label + description}</title>
      {/* A backdrop, because the corner of a layout is not reliably empty: a ray
          crossing behind the arrows leaves them unreadable exactly when the
          drawing is busy enough to need them. Sized to the labels rather than
          fixed, so it is never bigger than what it is protecting. */}
      <rect
        className="axis-triad-backdrop"
        x={left}
        y={top}
        width={right - left}
        height={bottom - top}
        rx={5}
      />
      {placed.map((entry) => (
        <g key={entry.axis} stroke={AXIS_COLOR[entry.axis]} fill={AXIS_COLOR[entry.axis]}>
          {entry.throughScreen ? (
            <>
              <circle
                className="axis-triad-glyph"
                cx={0}
                cy={0}
                r={GLYPH_RADIUS}
                strokeWidth={1.4}
              />
              {entry.toward > 0 ? (
                <circle cx={0} cy={0} r={GLYPH_DOT} stroke="none" />
              ) : (
                <>
                  <line
                    x1={-GLYPH_CROSS}
                    y1={-GLYPH_CROSS}
                    x2={GLYPH_CROSS}
                    y2={GLYPH_CROSS}
                    strokeWidth={1.4}
                  />
                  <line
                    x1={-GLYPH_CROSS}
                    y1={GLYPH_CROSS}
                    x2={GLYPH_CROSS}
                    y2={-GLYPH_CROSS}
                    strokeWidth={1.4}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <line
                x1={entry.shaft.x}
                y1={entry.shaft.y}
                x2={entry.tip.x}
                y2={entry.tip.y}
                strokeWidth={1.6}
              />
              <polygon points={head(entry.tip, entry.unit, entry.headSize)} stroke="none" />
            </>
          )}
          <text
            x={entry.label.x}
            y={entry.label.y}
            fontSize={LABEL_SIZE}
            stroke="none"
            textAnchor="middle"
            dominantBaseline="central"
          >
            {entry.axis.toUpperCase()}
          </text>
        </g>
      ))}
    </g>
  );
}
