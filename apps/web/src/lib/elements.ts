import { AIR, type Material, type OpticalSystem } from '@isaac/optical-core';

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
export type ElementKind = 'LENS' | 'MIRROR';

export interface OpticalElement {
  /**
   * What this element is made of. A `LENS` is a run of glass between two faces;
   * a `MIRROR` is one reflecting surface with air on both sides of it, which is
   * a thing you can pick up and mount even though no light passes through it.
   *
   * A mirror *inside* glass is not this: it is the back of a solid, so it stays
   * part of the run it reflects in — a Mangin mirror is one piece of glass with
   * a coating on its rear face, and both views already draw it as one body.
   */
  kind: ElementKind;
  /** Surface index of the front face. For a mirror, the mirror itself. */
  firstIndex: number;
  /** Surface index of the back face. For a mirror, the same surface again. */
  lastIndex: number;
  /**
   * A stable name for this element across edits: the id of its front surface.
   * Row indices shift when a surface is inserted; surface ids do not, so a label
   * the user chose stays with the element it was chosen for.
   */
  key: string;
  /**
   * 1-based position among the elements *of its kind*, which is the number in
   * the default name: lenses count L1, L2, … and mirrors M1, M2, … separately,
   * because they are separately what a designer counts.
   */
  ordinal: number;
  /**
   * The separate pieces of glass inside this element, front to back. A singlet
   * has one; a cemented doublet has two, because the two halves are different
   * glasses even though they are one thing to hold. Both views draw one body per
   * gap, so this is also the list of things that can carry a color.
   *
   * **A mirror has none.** There is no glass in it and no body to fill: both
   * views draw it as the surface it is, so its one color is the element's own
   * rather than a gap's — see {@link mirrorColor}.
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
 *
 * Two kinds come out of the same walk. A run of glass is a lens. A reflecting
 * surface with **no glass across it** is a mirror, and an element in its own
 * right: one surface, one row, one thing to mount. A reflecting surface *with*
 * glass across it is not — that is a Mangin mirror, the silvered back of a
 * solid, and it goes on being part of the run it sits in.
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
  // anywhere in the design open with the same default color. Mirrors are left
  // out of it deliberately: they wear the theme's mirror color rather than a
  // palette entry, so adding one does not repaint every lens behind it.
  let colorIndex = 0;
  // Lenses and mirrors are numbered apart, so a design reads L1 M1 L2 rather
  // than having its lenses renumbered by a fold mirror dropped between them.
  let lenses = 0;
  let mirrors = 0;
  let position = 0;
  while (position < faces.length - 1) {
    const firstIndex = faces[position]!;
    if (!isGlass(system.surfaceAt(firstIndex).material, wavelengthNm)) {
      // Air on the far side, and — because the model refuses a mirror that
      // changes medium — air on the near side too, so one test is both. A
      // reflecting surface here is a mirror on its own, not the back of a solid.
      if (system.surfaceAt(firstIndex).reflective) {
        mirrors += 1;
        elements.push({
          kind: 'MIRROR',
          firstIndex,
          lastIndex: firstIndex,
          key: system.surfaceAt(firstIndex).id,
          ordinal: mirrors,
          gaps: [],
        });
      }
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

    lenses += 1;
    elements.push({
      kind: 'LENS',
      firstIndex,
      lastIndex: faces[end]!,
      key: system.surfaceAt(firstIndex).id,
      ordinal: lenses,
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
  /**
   * Taken out of the light while left in the table.
   *
   * A "what does this element do?" switch: the rows stay exactly where they are,
   * and the *traced* system has the element's glass replaced by air, so rays
   * cross the space it occupied without being bent by it. Nothing moves — the
   * surfaces keep their positions and every thickness downstream is untouched —
   * which is what makes the before-and-after comparable.
   *
   * View state, like the label and the color, and for the same reason: it is a
   * question being asked of the design, not a change to it, so it must not land
   * on the undo stack or be written into a file.
   */
  hidden?: boolean;
}

export type ElementStyles = Readonly<Record<string, ElementStyle>>;

/** `L1`, `L2`, … for lenses and `M1`, `M2`, … for mirrors, unless renamed. */
export function elementLabel(element: OpticalElement, styles: ElementStyles): string {
  const chosen = styles[element.key]?.label?.trim();
  return chosen !== undefined && chosen !== ''
    ? chosen
    : `${element.kind === 'MIRROR' ? 'M' : 'L'}${element.ordinal}`;
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

/** True when this element has been switched out of the light. */
export function isHidden(element: OpticalElement, styles: ElementStyles): boolean {
  return styles[element.key]?.hidden === true;
}

/**
 * The surfaces belonging to elements that are switched out.
 *
 * The drawing takes this rather than working it out from the traced system,
 * which cannot: a hidden lens's faces are air-to-air there, and so is every
 * dummy plane in the design. Only the styles know which ones were switched off
 * on purpose.
 *
 * The two ends are never included. A lens whose rear face *is* the image plane
 * is a system the model allows, and dropping the image plane from the picture
 * because of a switch on the lens in front of it would take away the one surface
 * the rays are measured against.
 */
export function hiddenSurfaceIndices(
  system: OpticalSystem,
  styles: ElementStyles,
): ReadonlySet<number> {
  const hidden = new Set<number>();
  const last = system.surfaces.length - 1;
  for (const element of findElements(system)) {
    if (!isHidden(element, styles)) {
      continue;
    }
    for (let index = element.firstIndex; index <= element.lastIndex; index += 1) {
      if (index !== 0 && index !== last) {
        hidden.add(index);
      }
    }
  }
  return hidden;
}

/**
 * The system as it is *traced*, with every hidden element taken out of the light.
 *
 * A hidden lens becomes air: its faces stay where they are, and a surface with
 * the same medium either side has no power whatever its radius, so rays cross it
 * undeviated. A hidden **mirror** stops reflecting, and the light simply carries
 * on — which usually leaves the rest of a folded design somewhere the beam no
 * longer goes. That is the honest answer to "what if this mirror were not
 * there", and the picture says so rather than hiding it.
 *
 * The design itself is never touched: this is derived on every render from the
 * system and the styles, so switching an element back on restores exactly what
 * was there.
 */
export function systemAsTraced(system: OpticalSystem, styles: ElementStyles): OpticalSystem {
  const hidden = findElements(system).filter((element) => isHidden(element, styles));
  if (hidden.length === 0) {
    return system;
  }
  let traced = system;
  for (const element of hidden) {
    if (element.kind === 'MIRROR') {
      const surface = traced.surfaceAt(element.firstIndex);
      traced = traced.withSurfaceAt(element.firstIndex, surface.with({ reflective: false }));
      continue;
    }
    // Air across every gap the element is made of. The *last* face of a run
    // carries the medium after the element, which belongs to whatever follows
    // and is left alone.
    for (const gap of element.gaps) {
      for (let index = gap.frontIndex; index < gap.backIndex; index += 1) {
        traced = traced.withSurfaceAt(index, traced.surfaceAt(index).with({ material: AIR }));
      }
    }
  }
  return traced;
}

/** True when the user has overridden this gap's color. */
export function hasChosenColor(gap: ElementGap, styles: ElementStyles): boolean {
  return styles[gap.key]?.color !== undefined;
}

/**
 * The color one mirror is drawn in.
 *
 * Its default is **the theme's own `--mirror`**, passed in resolved, not a fixed
 * hex from the palette. Two reasons, and they point the same way. A mirror is
 * not glass, so it should no more wear a glass color than the ends do — and
 * unlike the ends it is already drawn in a token that *moves between themes*
 * (`#5f7180` light, `#9fb4c4` dark), so pinning a hex here would freeze it to
 * one of them. The swatch therefore shows exactly what is on screen, in either
 * theme, which is the whole point of the swatch.
 */
export function mirrorColor(
  element: OpticalElement,
  styles: ElementStyles,
  themeMirror: string,
): string {
  return styles[element.key]?.color ?? themeMirror;
}

/** True when the user has overridden a mirror's color. */
export function hasChosenMirrorColor(element: OpticalElement, styles: ElementStyles): boolean {
  return styles[element.key]?.color !== undefined;
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
 * The two ends of the system — the object plane and the image plane.
 *
 * Neither is a piece of glass, so neither is an element: they are single
 * surfaces, and the walk in `findElements` starts past the object and can never
 * make the image a *front* face. They are still two of the things a layout
 * draws and two of the rows a designer looks for, so they get a name and a color
 * in the Element column like everything else, and they share `ElementStyles`
 * because that is already keyed by surface id and their ids are ones no gap can
 * claim.
 *
 * Their names are fixed rather than editable. `L1` is a name for a lens that
 * happens to be first; OBJ and IMG are what these surfaces *are*, decided by
 * position, and there would be nowhere to put a different one.
 */
export interface SystemEnd {
  /** Surface index: 0, or the last surface. */
  index: number;
  /** Stable key across edits, and the `ElementStyles` key — the surface's id. */
  key: string;
  label: string;
  defaultColor: string;
}

export const OBJECT_END_LABEL = 'OBJ';
export const IMAGE_END_LABEL = 'IMG';

/**
 * Deliberately outside `ELEMENT_PALETTE`, and deliberately not theme tokens.
 * These are not glass, so they should not be handed a glass color, and a chosen
 * color is a decision about *this design* that must not move when the theme does
 * — the same reasoning the palette already carries. Grey for the image because
 * it is where light stops rather than something light passes through.
 */
export const OBJECT_END_COLOR = '#8fa3b8';
export const IMAGE_END_COLOR = '#8c8c8c';

export function systemEnds(system: OpticalSystem): readonly SystemEnd[] {
  const last = system.surfaces.length - 1;
  return [
    {
      index: 0,
      key: system.surfaceAt(0).id,
      label: OBJECT_END_LABEL,
      defaultColor: OBJECT_END_COLOR,
    },
    {
      index: last,
      key: system.surfaceAt(last).id,
      label: IMAGE_END_LABEL,
      defaultColor: IMAGE_END_COLOR,
    },
  ];
}

/** The color an end is drawn in: the user's choice if there is one. */
export function endColor(end: SystemEnd, styles: ElementStyles): string {
  return styles[end.key]?.color ?? end.defaultColor;
}

/** True when the user has overridden this end's color. */
export function hasChosenEndColor(end: SystemEnd, styles: ElementStyles): boolean {
  return styles[end.key]?.color !== undefined;
}

/**
 * The color of everything drawn as a *single surface* rather than as a body:
 * the two ends, and any mirror the user has given a color to. Keyed by surface
 * index, and what both layout views take.
 *
 * Kept apart from {@link elementColorsBySurface} rather than merged into it:
 * that map is read by *body*, and the 2-D view strokes a profile for every
 * surface including the faces of a lens, so one combined map would quietly paint
 * every lens face in its body's color too.
 *
 * A mirror appears **only once its color has been chosen**. Its default is a
 * theme token, and the views already resolve that token themselves — putting a
 * value here for an untouched mirror would swap a color that follows the theme
 * for one frozen to whichever theme was on when it was read.
 */
export function surfaceColorsBySurface(
  system: OpticalSystem,
  styles: ElementStyles,
): ReadonlyMap<number, string> {
  const colors = new Map<number, string>();
  for (const end of systemEnds(system)) {
    colors.set(end.index, endColor(end, styles));
  }
  for (const element of findElements(system)) {
    const chosen = element.kind === 'MIRROR' ? styles[element.key]?.color : undefined;
    if (chosen !== undefined) {
      colors.set(element.firstIndex, chosen);
    }
  }
  return colors;
}

/**
 * Colors this design already uses, so a second piece of glass can be given the
 * same one without matching a hex by eye. In system order and de-duplicated.
 *
 * Defaults count as "in use": they are what is on screen, which is what makes
 * the row worth reading. Palette entries are not excluded for the same reason —
 * the row answers "what is already here", the palette below answers "what else
 * could I use", and dropping the overlap would empty the row almost always.
 */
export function colorsInUse(
  elements: readonly OpticalElement[],
  styles: ElementStyles,
  ends: readonly SystemEnd[] = [],
  themeMirror?: string,
): string[] {
  const seen = new Set<string>();
  const used: string[] = [];
  const add = (color: string): void => {
    const key = color.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    used.push(key);
  };
  for (const element of elements) {
    if (element.kind === 'MIRROR') {
      // Only when the theme's value is to hand: without it there is no color to
      // name, and offering a mirror's default under some other theme's hex would
      // be offering a color nothing on screen is drawn in.
      const color = themeMirror ?? styles[element.key]?.color;
      if (color !== undefined) {
        add(mirrorColor(element, styles, color));
      }
      continue;
    }
    for (const gap of element.gaps) {
      add(gapColor(gap, styles));
    }
  }
  for (const end of ends) {
    add(endColor(end, styles));
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
