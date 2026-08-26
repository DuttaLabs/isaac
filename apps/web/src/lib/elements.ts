import type { Material, OpticalSystem } from '@isaac/optical-core';

/**
 * Which surfaces are the two faces of one piece of glass.
 *
 * The model has no notion of an element — it has a list of surfaces, and a
 * surface's `material` is the medium *after* it. A lens is therefore implied
 * rather than stored: a surface whose following medium is glass, and the next
 * drawn surface after it, are the front and back of something solid. That is
 * exactly the rule `layout.ts` already uses to fill a cross-section and
 * `three-optics` uses to revolve a solid, so the elements named here are the same
 * ones both views draw, and a color chosen against one lands on the other.
 *
 * A run of glass is kept whole. A cemented doublet is three surfaces with glass
 * across both gaps, and it is one thing you can pick up, so it is one element
 * spanning three rows rather than two elements fighting over the middle row. The
 * views still draw it as two bodies, one per gap, because the two halves are
 * different glasses — they simply take the same color.
 *
 * Nothing here is stored on `OpticalSystem`. Elements are derived on demand, so
 * they cannot fall out of step with the surfaces they are made of.
 */
export interface OpticalElement {
  /** Surface index of the front face. */
  firstIndex: number;
  /** Surface index of the back face. */
  lastIndex: number;
  /**
   * A stable name for this element across edits: the id of its front surface.
   * Row indices shift when a surface is inserted; surface ids do not, so a label
   * the user chose stays with the element it was chosen for.
   */
  key: string;
  /** 1-based position in the system, which is the number in the default `L#`. */
  ordinal: number;
  /**
   * The separate pieces of glass inside this element, front to back. A singlet
   * has one; a cemented doublet has two, because the two halves are different
   * glasses even though they are one thing to hold. Both views draw one body per
   * gap, so this is also the list of things that can carry a color.
   */
  gaps: ElementGap[];
}

/** One piece of glass: the span between two faces with the same medium across it. */
export interface ElementGap {
  /** Surface index where the glass begins — how both views identify this body. */
  frontIndex: number;
  /** Surface index where it ends. */
  backIndex: number;
  /** Stable key across edits: the id of the front surface. */
  key: string;
  /** Position among every gap in the system, which picks the default color. */
  colorIndex: number;
}

/** Air is index 1. Anything else at the primary wavelength is something solid. */
export function isGlass(material: Material, wavelengthNm: number): boolean {
  return Math.abs(material.indexAt(wavelengthNm) - 1) >= 1e-9;
}

/**
 * Every element in the system, front to back.
 *
 * A `COORDINATE_TRANSFORM` is skipped rather than treated as a face: it has no
 * shape and meets no ray, and it carries the medium before it, so left in the
 * walk it would look like the middle of a piece of glass. It can still sit
 * *inside* an element's span — a tilted rear face is written exactly that way —
 * and the span covers it, because the rows in between belong to the element even
 * though they are not faces of it.
 */
export function findElements(system: OpticalSystem): OpticalElement[] {
  const wavelengthNm = system.primaryWavelengthNm;
  // The surfaces a ray actually meets, in order. Faces are found among these, so
  // a transform between two faces never breaks an element in half.
  const faces: number[] = [];
  for (let index = 1; index < system.surfaces.length; index += 1) {
    if (system.surfaceAt(index).type !== 'COORDINATE_TRANSFORM') {
      faces.push(index);
    }
  }

  const elements: OpticalElement[] = [];
  // Counted across the whole system, not per element, so no two pieces of glass
  // anywhere in the design open with the same default color.
  let colorIndex = 0;
  let position = 0;
  while (position < faces.length - 1) {
    const firstIndex = faces[position]!;
    if (!isGlass(system.surfaceAt(firstIndex).material, wavelengthNm)) {
      position += 1;
      continue;
    }
    // Walk forward while the glass continues, recording each gap as we cross it:
    // a further face still in glass is a cemented interface, not the back of the
    // element, but it *is* the start of a second piece of glass.
    const gaps: ElementGap[] = [];
    let end = position;
    do {
      const front = faces[end]!;
      const back = faces[end + 1]!;
      gaps.push({
        frontIndex: front,
        backIndex: back,
        key: system.surfaceAt(front).id,
        colorIndex: colorIndex,
      });
      colorIndex += 1;
      end += 1;
    } while (
      end < faces.length - 1 &&
      isGlass(system.surfaceAt(faces[end]!).material, wavelengthNm)
    );

    elements.push({
      firstIndex,
      lastIndex: faces[end]!,
      key: system.surfaceAt(firstIndex).id,
      ordinal: elements.length + 1,
      gaps,
    });
    // The back face of one element can be the front of the next only if the
    // glass never stopped, which the walk above has already consumed.
    position = end;
  }
  return elements;
}

/** The element a surface row belongs to, face or interior, or `undefined`. */
export function elementAt(
  elements: readonly OpticalElement[],
  surfaceIndex: number,
): OpticalElement | undefined {
  return elements.find(
    (element) => surfaceIndex >= element.firstIndex && surfaceIndex <= element.lastIndex,
  );
}

/** How many table rows one element covers, for the cell that spans them. */
export function elementRowSpan(element: OpticalElement): number {
  return element.lastIndex - element.firstIndex + 1;
}

/**
 * What the user has changed about an element, keyed by {@link OpticalElement.key}.
 *
 * This is view state and lives in `App`, never on `OpticalSystem`: a `.zmx` has
 * nowhere to put a label or a color, so storing them on the model would either
 * be dropped silently on save or break the round trip that says a file written
 * and read back is the same system. Anything absent falls back to the default.
 */
export interface ElementStyle {
  label?: string;
  /** A CSS color the user picked. Absent means the theme's own glass color. */
  color?: string;
}

export type ElementStyles = Readonly<Record<string, ElementStyle>>;

/** `L1`, `L2`, … unless the user has renamed it. */
export function elementLabel(element: OpticalElement, styles: ElementStyles): string {
  const chosen = styles[element.key]?.label?.trim();
  return chosen !== undefined && chosen !== '' ? chosen : `L${element.ordinal}`;
}

/**
 * The color one piece of glass is drawn in: the user's choice if there is one,
 * otherwise its default from the palette.
 *
 * Every gap has a color from the start rather than falling back to a single
 * neutral. A design opens with its elements already told apart, which is the
 * point of coloring them, and the swatch in the table then always shows a real
 * color instead of a placeholder standing in for one.
 */
export function gapColor(gap: ElementGap, styles: ElementStyles): string {
  return styles[gap.key]?.color ?? defaultGapColor(gap);
}

/** The palette entry a gap starts with, by its position in the system. */
export function defaultGapColor(gap: ElementGap): string {
  return ELEMENT_PALETTE[gap.colorIndex % ELEMENT_PALETTE.length]!;
}

/** True when the user has overridden this gap's color. */
export function hasChosenColor(gap: ElementGap, styles: ElementStyles): boolean {
  return styles[gap.key]?.color !== undefined;
}

/**
 * Colors offered in the picker before any custom one: enough to tell a handful
 * of elements apart, and muted enough to read as glass rather than as plastic.
 * Fixed hex values, not theme tokens, because a chosen color is a decision about
 * *this design* and should not change when the user switches theme.
 */
export const ELEMENT_PALETTE: readonly string[] = [
  '#7db9d4',
  '#8fcfa8',
  '#e0c274',
  '#e29a86',
  '#b79ad6',
  '#8aa8cc',
  '#a9c98c',
  '#d4a0b8',
];

/**
 * Colors this design already uses, so a second piece of glass can be given the
 * same one without matching a hex by eye. In system order and de-duplicated.
 *
 * Defaults count as "in use": they are what is on screen, which is what makes
 * the row worth reading. Palette entries are not excluded for the same reason —
 * the row answers "what is already here", the palette below answers "what else
 * could I use", and dropping the overlap would empty the row almost always.
 */
export function colorsInUse(elements: readonly OpticalElement[], styles: ElementStyles): string[] {
  const seen = new Set<string>();
  const used: string[] = [];
  for (const element of elements) {
    for (const gap of element.gaps) {
      const color = gapColor(gap, styles).toLowerCase();
      if (seen.has(color)) {
        continue;
      }
      seen.add(color);
      used.push(color);
    }
  }
  return used;
}

/**
 * The color of every piece of glass, keyed by the surface its body starts at.
 *
 * Both views identify a body by its front surface, and a cemented doublet is two
 * bodies inside one element — so keying by surface is what lets the two halves
 * be told apart, which is the whole reason a doublet gets two swatches.
 */
export function elementColorsBySurface(
  system: OpticalSystem,
  styles: ElementStyles,
): ReadonlyMap<number, string> {
  const colors = new Map<number, string>();
  for (const element of findElements(system)) {
    for (const gap of element.gaps) {
      colors.set(gap.frontIndex, gapColor(gap, styles));
    }
  }
  return colors;
}
