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
 * too).
 */

/**
 * What the aperture does to a ray that meets the surface inside it.
 *
 * Circular only, for now. The rectangular (`SQAP`, 57 records) and elliptical
 * (`ELAP`, 2) forms are the same idea with a different boundary, and the user
 * forms (`UDAD`) are a polygon read from a separate file; each is a case added
 * here and in {@link apertureBlocks}, not a new concept.
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
  | 'FLOATING';

export interface SurfaceApertureConfig {
  kind: ApertureKind;
  /** Inner radius, in system units. 0 for an aperture with no hole in it. */
  minRadius?: number;
  /** Outer radius, in system units. Ignored — and defaulted — for `FLOATING`. */
  maxRadius?: number;
  /** Aperture center, off the surface's own axis. */
  decenterX?: number;
  decenterY?: number;
}

export interface SurfaceAperture {
  readonly kind: ApertureKind;
  readonly minRadius: number;
  /** `Infinity` on a `FLOATING` aperture, whose radius is the semi-diameter. */
  readonly maxRadius: number;
  readonly decenterX: number;
  readonly decenterY: number;
}

/**
 * Checks an aperture and freezes it. Rejects rather than repairs, like every
 * other constructor here: an aperture with its radii the wrong way round stops
 * every ray, and a system that traces nothing at all looks like a bug somewhere
 * else entirely.
 */
export function normalizeAperture(
  config: SurfaceApertureConfig | SurfaceAperture | undefined,
): SurfaceAperture | undefined {
  if (config === undefined) {
    return undefined;
  }
  const floating = config.kind === 'FLOATING';
  const minRadius = config.minRadius ?? 0;
  const maxRadius = config.maxRadius ?? (floating ? Infinity : 0);
  const decenterX = config.decenterX ?? 0;
  const decenterY = config.decenterY ?? 0;

  if (!Number.isFinite(minRadius) || minRadius < 0) {
    throw new RangeError('Aperture minRadius must be zero or a positive number.');
  }
  if (floating) {
    // Its radius is the semi-diameter, so a second one here would be a
    // contradiction rather than an extra: refuse it the way a PARAXIAL surface
    // refuses a radius.
    if (Number.isFinite(maxRadius)) {
      throw new RangeError('A FLOATING aperture takes its radius from the semi-diameter.');
    }
  } else if (!Number.isFinite(maxRadius) || maxRadius <= 0) {
    throw new RangeError('Aperture maxRadius must be a positive number.');
  } else if (maxRadius <= minRadius) {
    throw new RangeError('Aperture maxRadius must be greater than minRadius.');
  }
  if (!Number.isFinite(decenterX) || !Number.isFinite(decenterY)) {
    throw new RangeError('Aperture decenters must be finite numbers.');
  }

  return Object.freeze({ kind: config.kind, minRadius, maxRadius, decenterX, decenterY });
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
  const radial = Math.hypot(x - aperture.decenterX, y - aperture.decenterY);
  switch (aperture.kind) {
    case 'FLOATING':
      return radial > semiDiameter + epsilon;
    case 'CIRCULAR':
      return radial < aperture.minRadius - epsilon || radial > aperture.maxRadius + epsilon;
    case 'CIRCULAR_OBSCURATION':
      // Inclusive at both ends: an obscuration is a solid thing, and a ray
      // arriving exactly at its rim meets it.
      return radial >= aperture.minRadius - epsilon && radial <= aperture.maxRadius + epsilon;
  }
}

/**
 * The outer radius the aperture actually limits at, with a `FLOATING` one
 * resolved against the semi-diameter it borrows. What a drawing wants.
 */
export function apertureOuterRadius(
  aperture: SurfaceAperture | undefined,
  semiDiameter: number,
): number {
  if (aperture === undefined) {
    return Infinity;
  }
  return aperture.kind === 'FLOATING' ? semiDiameter : aperture.maxRadius;
}
