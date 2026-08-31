/**
 * A surface aperture: the hole light actually goes through, as opposed to the
 * extent the surface is *drawn* at.
 *
 * The two have been one thing until now, and they are not the same thing. A
 * `.zmx` file carries a semi-diameter on every surface — usually computed by the
 * program, as the radius the rays happened to reach — and it vignettes nothing;
 * it says how big to draw the glass. Vignetting is a separate, explicit record,
 * and a file that wants its semi-diameter to clip says so with one (`FLAP`,
 * which 141 of the 471 sample files carry for exactly that reason).
 *
 * So an aperture here is opt-in. A surface without one stops no ray, however
 * far off axis it is met — which is what OpticStudio does, and what makes the
 * Hubble's baffle surface (drawn at r = 0.155, obscuring everything *inside*
 * that radius) come out as a shadow rather than as a wall.
 *
 * **The decenter belongs to the aperture, not to the surface.** That is the
 * file format's own arrangement — one `OBDC x y` record serving whichever
 * aperture the surface has — and it is the right one: a decentered aperture is
 * an off-axis hole in a centered surface, which is a different thing from a
 * decentered surface (that is a coordinate transform, and it moves the glass
 * too). It is also how an **off-axis element** is written: Zemax's Unobscured
 * Gregorian is a parent conic whose vertex a coordinate break puts 100 mm off
 * the beam, with a 55 mm clear aperture decentered 100 mm back onto it. The
 * aperture there is not a hole in the mirror — it is *which piece of the parent
 * surface the mirror is*.
 */

/**
 * What the aperture does to a ray that meets the surface inside it.
 *
 * Two families, and the split is in the numbers each needs rather than in what
 * they do: the circular kinds are bounded by two radii, and the rectangular and
 * elliptical ones by a half-width in x and one in y. Each family has an
 * *aperture* (light passes inside, is stopped outside) and an *obscuration*
 * (the other way round), which is Zemax's own arrangement, record for record.
 *
 * `SPID` — the spider, a set of radial arms — is the one aperture record in the
 * corpus this does not cover. It is a different shape rather than a different
 * size, so it belongs here as its own kind when it lands, not as a special case
 * of one of these.
 */
export type ApertureKind =
  /** `CLAP`: light passes between `minRadius` and `maxRadius`, and nowhere else. */
  | 'CIRCULAR'
  /** `OBSC`: light is stopped between `minRadius` and `maxRadius`, and passes elsewhere. */
  | 'CIRCULAR_OBSCURATION'
  /**
   * `FLAP`: a circular aperture whose radius *is* the surface's semi-diameter,
   * and follows it. The commonest record in the corpus by a factor of six, and
   * the one that asks for the behavior Isaac used to give every surface whether
   * it asked or not.
   */
  | 'FLOATING'
  /** `SQAP`: light passes inside the rectangle `±halfWidthX` by `±halfWidthY`. */
  | 'RECTANGULAR'
  /** `SQOB`: light is stopped inside that rectangle and passes outside it. */
  | 'RECTANGULAR_OBSCURATION'
  /** `ELAP`: light passes inside the ellipse with those two semi-axes. */
  | 'ELLIPTICAL'
  /** `ELOB`: light is stopped inside that ellipse. */
  | 'ELLIPTICAL_OBSCURATION';

/** The kinds bounded by two radii rather than by two half-widths. */
export const CIRCULAR_APERTURE_KINDS: readonly ApertureKind[] = [
  'CIRCULAR',
  'CIRCULAR_OBSCURATION',
  'FLOATING',
];

/** The kinds that stop the middle and pass the outside. */
export const OBSCURING_APERTURE_KINDS: readonly ApertureKind[] = [
  'CIRCULAR_OBSCURATION',
  'RECTANGULAR_OBSCURATION',
  'ELLIPTICAL_OBSCURATION',
];

/** True when this kind is bounded by radii; false when by half-widths. */
export function isCircularAperture(kind: ApertureKind): boolean {
  return CIRCULAR_APERTURE_KINDS.includes(kind);
}

/**
 * True when the aperture stops the middle rather than the outside — which also
 * means it does **not** bound the surface: an obscuration is something in the
 * way of a surface, not the edge of one.
 */
export function isObscuration(kind: ApertureKind): boolean {
  return OBSCURING_APERTURE_KINDS.includes(kind);
}

export interface SurfaceApertureConfig {
  kind: ApertureKind;
  /** Inner radius, in system units. Circular kinds only; 0 for no hole. */
  minRadius?: number;
  /** Outer radius, in system units. Circular kinds only, and never `FLOATING`. */
  maxRadius?: number;
  /** Half-width across x. Rectangular and elliptical kinds only. */
  halfWidthX?: number;
  /** Half-width across y. Rectangular and elliptical kinds only. */
  halfWidthY?: number;
  /** Aperture center, off the surface's own axis. Every kind takes one. */
  decenterX?: number;
  decenterY?: number;
}

export interface SurfaceAperture {
  readonly kind: ApertureKind;
  /** Circular kinds only; 0 on the others, where it has no meaning. */
  readonly minRadius: number;
  /** Circular kinds only; `Infinity` on `FLOATING`, 0 on the others. */
  readonly maxRadius: number;
  /** Rectangular and elliptical kinds only; 0 on the circular ones. */
  readonly halfWidthX: number;
  readonly halfWidthY: number;
  readonly decenterX: number;
  readonly decenterY: number;
}

/**
 * Checks an aperture and freezes it.
 *
 * Rejects rather than repairs, like every other constructor here: an aperture
 * with its radii the wrong way round stops every ray, and a system that traces
 * nothing at all looks like a bug somewhere else entirely.
 *
 * **A number belonging to the other family is refused, not ignored** — the same
 * rule that stops a `PARAXIAL` surface carrying a radius. A rectangular aperture
 * with a `maxRadius` has two contradictory statements of its size in it, and
 * quietly keeping one of them is how a file comes back as a different lens.
 */
export function normalizeAperture(
  config: SurfaceApertureConfig | SurfaceAperture | undefined,
): SurfaceAperture | undefined {
  if (config === undefined) {
    return undefined;
  }
  const circular = isCircularAperture(config.kind);
  const decenterX = config.decenterX ?? 0;
  const decenterY = config.decenterY ?? 0;
  if (!Number.isFinite(decenterX) || !Number.isFinite(decenterY)) {
    throw new RangeError('Aperture decenters must be finite numbers.');
  }

  if (circular) {
    // Non-zero rather than merely present: this function is handed its own
    // output every time a `Surface` is copied, and a normalized circular
    // aperture carries half-widths of zero. Refusing those would make an
    // aperture impossible to edit.
    if (nonZero(config.halfWidthX) || nonZero(config.halfWidthY)) {
      throw new RangeError(`A ${config.kind} aperture is bounded by radii, not by half-widths.`);
    }
    const floating = config.kind === 'FLOATING';
    const minRadius = config.minRadius ?? 0;
    const maxRadius = config.maxRadius ?? (floating ? Infinity : 0);
    if (!Number.isFinite(minRadius) || minRadius < 0) {
      throw new RangeError('Aperture minRadius must be zero or a positive number.');
    }
    if (floating) {
      // Its radius is the semi-diameter, so a second one here would be a
      // contradiction rather than an extra.
      if (Number.isFinite(maxRadius)) {
        throw new RangeError('A FLOATING aperture takes its radius from the semi-diameter.');
      }
    } else if (!Number.isFinite(maxRadius) || maxRadius <= 0) {
      throw new RangeError('Aperture maxRadius must be a positive number.');
    } else if (maxRadius <= minRadius) {
      throw new RangeError('Aperture maxRadius must be greater than minRadius.');
    }
    return Object.freeze({
      kind: config.kind,
      minRadius,
      maxRadius,
      halfWidthX: 0,
      halfWidthY: 0,
      decenterX,
      decenterY,
    });
  }

  if (nonZero(config.minRadius) || nonZero(config.maxRadius)) {
    throw new RangeError(`A ${config.kind} aperture is bounded by half-widths, not by radii.`);
  }
  const halfWidthX = config.halfWidthX ?? 0;
  const halfWidthY = config.halfWidthY ?? 0;
  if (!Number.isFinite(halfWidthX) || halfWidthX <= 0) {
    throw new RangeError('Aperture halfWidthX must be a positive number.');
  }
  if (!Number.isFinite(halfWidthY) || halfWidthY <= 0) {
    throw new RangeError('Aperture halfWidthY must be a positive number.');
  }
  return Object.freeze({
    kind: config.kind,
    minRadius: 0,
    maxRadius: 0,
    halfWidthX,
    halfWidthY,
    decenterX,
    decenterY,
  });
}

/**
 * Whether a ray meeting the surface at `(x, y)` — **in the surface's own local
 * frame**, so a tilted element vignettes by its aperture and not by its tilt —
 * is stopped by this aperture.
 *
 * `semiDiameter` is passed in because a `FLOATING` aperture is defined as that
 * number; every other kind ignores it. Keeping the whole rule in one function
 * is what stops the tracer and the two layout views from disagreeing about
 * where the hole in a mirror is.
 */
export function apertureBlocks(
  aperture: SurfaceAperture | undefined,
  semiDiameter: number,
  x: number,
  y: number,
  epsilon = 0,
): boolean {
  if (aperture === undefined) {
    return false;
  }
  const dx = x - aperture.decenterX;
  const dy = y - aperture.decenterY;
  switch (aperture.kind) {
    case 'FLOATING':
      return Math.hypot(dx, dy) > semiDiameter + epsilon;
    case 'CIRCULAR': {
      const radial = Math.hypot(dx, dy);
      return radial < aperture.minRadius - epsilon || radial > aperture.maxRadius + epsilon;
    }
    case 'CIRCULAR_OBSCURATION': {
      // Inclusive at both ends: an obscuration is a solid thing, and a ray
      // arriving exactly at its rim meets it.
      const radial = Math.hypot(dx, dy);
      return radial >= aperture.minRadius - epsilon && radial <= aperture.maxRadius + epsilon;
    }
    case 'RECTANGULAR':
      return !insideRectangle(aperture, dx, dy, epsilon);
    case 'RECTANGULAR_OBSCURATION':
      return insideRectangle(aperture, dx, dy, -epsilon);
    case 'ELLIPTICAL':
      return !insideEllipse(aperture, dx, dy, epsilon);
    case 'ELLIPTICAL_OBSCURATION':
      return insideEllipse(aperture, dx, dy, -epsilon);
  }
}

/** Present and meaning something: zero is what a normalized aperture carries. */
function nonZero(value: number | undefined): boolean {
  return value !== undefined && value !== 0;
}

function insideRectangle(
  aperture: SurfaceAperture,
  dx: number,
  dy: number,
  epsilon: number,
): boolean {
  return (
    Math.abs(dx) <= aperture.halfWidthX + epsilon && Math.abs(dy) <= aperture.halfWidthY + epsilon
  );
}

/**
 * The ellipse is `(dx/a)² + (dy/b)² ≤ 1`, with the tolerance applied to the
 * *radius* rather than to the squared sum, so an epsilon in system units still
 * means an epsilon in system units on either axis.
 */
function insideEllipse(
  aperture: SurfaceAperture,
  dx: number,
  dy: number,
  epsilon: number,
): boolean {
  const a = aperture.halfWidthX + epsilon;
  const b = aperture.halfWidthY + epsilon;
  return a > 0 && b > 0 && (dx / a) ** 2 + (dy / b) ** 2 <= 1;
}

/**
 * The largest circle, centered on the aperture, that the aperture passes.
 *
 * What a *pupil* wants: the stop's clear radius sizes the pupils, and a lost ray
 * is charged the radius it must have been outside. `Infinity` where nothing is
 * bounded — an obscuration, or no aperture at all — which callers with a
 * fallback of their own can test for.
 *
 * The inscribed circle rather than the circumscribed one, because the question
 * is what gets through: a 25 by 40 rectangle passes a 25 circle, not a 40 one.
 */
export function apertureClearRadius(
  aperture: SurfaceAperture | undefined,
  semiDiameter: number,
): number {
  if (aperture === undefined || isObscuration(aperture.kind)) {
    return Infinity;
  }
  switch (aperture.kind) {
    case 'FLOATING':
      return semiDiameter;
    case 'CIRCULAR':
      return aperture.maxRadius;
    default:
      return Math.min(aperture.halfWidthX, aperture.halfWidthY);
  }
}

/**
 * How far the aperture reaches along x and y — the box the surface is drawn
 * inside, before its decenter is applied.
 *
 * `undefined` when the aperture does not bound the surface at all: an
 * obscuration is something in the way of a surface rather than the edge of one,
 * so the surface keeps whatever extent it had.
 */
export function apertureHalfExtents(
  aperture: SurfaceAperture | undefined,
  semiDiameter: number,
): { x: number; y: number } | undefined {
  if (aperture === undefined || isObscuration(aperture.kind)) {
    return undefined;
  }
  switch (aperture.kind) {
    case 'FLOATING':
      return { x: semiDiameter, y: semiDiameter };
    case 'CIRCULAR':
      return { x: aperture.maxRadius, y: aperture.maxRadius };
    default:
      return { x: aperture.halfWidthX, y: aperture.halfWidthY };
  }
}
