import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Material, OpticalSystem } from '@isaac/optical-core';
import {
  GLASS_CATALOG,
  MIRROR_MATERIAL_LABEL,
  MODEL_GLASS_HINT,
  MODEL_MATERIAL_LABEL,
  isMirrorText,
  materialFromText,
  materialLabel,
  modelGlassFromText,
  modelGlassText,
} from '../lib/materials.ts';
import {
  insertSurfaceAfter,
  insertSurfaceBefore,
  normalizeRadius,
  normalizeSemiDiameter,
  removeSurface,
  setMirror,
  setStop,
  setSurfaceType,
  updateCoordinateTransform,
  updateSurface,
  type EditableSurfaceType,
} from '../lib/edits.ts';
import { quickFocus } from '../lib/focus.ts';
import { formatLength, formatMicrons } from '../lib/format.ts';
import { chain, type Result } from '../lib/result.ts';
import { AsphericCoefficientsDialog, AsphericSummaryButton } from './AsphericCoefficients.tsx';
import {
  CoordinateTransformDialog,
  CoordinateTransformSummaryButton,
} from './CoordinateTransformEditor.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import type { MenuPoint } from '../lib/context-menu.ts';
import { ErrorNote, Panel, type PanelChoice } from './Panel.tsx';
import { NumericCell } from './NumericCell.tsx';
import { TextCell } from './TextCell.tsx';
import { ElementColorPicker } from './ElementColorPicker.tsx';
import {
  colorsInUse,
  defaultGapColor,
  elementLabel,
  elementRowSpan,
  endColor,
  findElements,
  gapColor,
  hasChosenColor,
  hasChosenEndColor,
  hasChosenMirrorColor,
  mirrorColor,
  systemEnds,
  type ElementStyles,
} from '../lib/elements.ts';
import { useThemeColors } from '../lib/theme-colors.ts';

/**
 * One thing in the Element column that can be given a color — a piece of glass
 * or an end of the system — flattened so the picker need not know which it was
 * opened on.
 */
interface ColorTarget {
  key: string;
  label: string;
  color: string;
  defaultColor: string;
  isDefault: boolean;
}

const MATERIAL_LIST_ID = 'material-names';

/**
 * The spreadsheet the design is actually edited in. Every cell edit produces a
 * new OpticalSystem; if the model rejects the change the previous system stays
 * on screen and the reason is shown under the table.
 */
export function LensDataEditor({
  system,
  onChange,
  onHighlight,
  highlightedSurface,
  elementStyles,
  onElementStyle,
  choice,
}: {
  system: OpticalSystem;
  onChange: (system: OpticalSystem) => void;
  /** Labels and colors the user has given elements, keyed by front surface id. */
  elementStyles: ElementStyles;
  /** Records one change; `undefined` clears that part back to the default. */
  onElementStyle: (key: string, change: { label?: string; color?: string | undefined }) => void;
  /** Reports the surface the user is on, so the layout can point it out. */
  onHighlight: (surfaceIndex: number | undefined) => void;
  /** The surface currently pointed out, which the arrow keys step through. */
  highlightedSurface: number | undefined;
  choice?: PanelChoice;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  /** Surface whose aspheric coefficients are open in the modal, if any. */
  const [asphereSurface, setAsphereSurface] = useState<number | undefined>(undefined);
  /** Surface whose coordinate transform is open in the modal, if any. */
  const [transformSurface, setTransformSurface] = useState<number | undefined>(undefined);
  /** The piece of glass whose color picker is open, by its key, if any. */
  const [colorGap, setColorGap] = useState<string | undefined>(undefined);
  /** Where the right-click menu is up, and which row it was opened on. */
  const [menu, setMenu] = useState<{ at: MenuPoint; index: number } | undefined>(undefined);
  const rows = useRef<(HTMLTableRowElement | null)[]>([]);
  const table = useRef<HTMLDivElement>(null);
  // A mirror's default color is the theme's own, resolved, so its swatch shows
  // what is actually drawn in whichever theme is on.
  const { mirror: themeMirror } = useThemeColors();

  /*
   * Where the frozen Element column has to sit: the rendered width of the
   * Surface column beside it, published to CSS as `--frozen-offset`.
   *
   * Measured rather than written down, because `table-layout: fixed` only hands
   * out the colgroup's declared widths when they happen to total the width of
   * the table. They do not: they sum to more than the `min-width`, so every
   * column is already scaled a little, and they scale the other way once a panel
   * is wider than the grid. A constant here would be right at exactly one panel
   * width and quietly wrong at every other, leaving the two frozen columns
   * overlapping or a gap between them.
   *
   * Written straight to the element's style rather than held in state — this is
   * a measurement of what was just laid out, and putting it through a render
   * would mean laying out again to use it.
   */
  useLayoutEffect(() => {
    const scroll = table.current;
    if (scroll === null) {
      return;
    }
    const sync = (): void => {
      const first = scroll.querySelector('thead th');
      if (first !== null) {
        scroll.style.setProperty('--frozen-offset', `${first.getBoundingClientRect().width}px`);
      }
    };
    sync();

    // The observer has to come from the realm the panel is in: one built from
    // the opener's `window` never reports on an element in the second window.
    const view = scroll.ownerDocument.defaultView;
    if (view === null) {
      return;
    }
    const observer = new view.ResizeObserver(sync);
    observer.observe(scroll);
    return () => observer.disconnect();
    // Mount and resize only, rather than every commit. The rendered width of a
    // column is a function of the table's width and nothing else — the colgroup
    // is fixed, and the table takes the container — so the observer sees every
    // change there is, and re-measuring on each render would force a layout on
    // every keystroke to learn a number that had not moved.
  }, []);
  const [pointerInside, setPointerInside] = useState(false);

  // The row the cursor is on, by hover or by keyboard focus — both set
  // `highlightedSurface`. Guarded against an index left over from a system that
  // has since lost that surface.
  // Derived, never stored: an element is implied by where the glass is, so it
  // cannot fall out of step with the surfaces it is made of.
  const elements = useMemo(() => findElements(system), [system]);
  const elementStart = useMemo(
    () => new Map(elements.map((element) => [element.firstIndex, element])),
    [elements],
  );
  const coveredRows = useMemo(() => {
    const covered = new Set<number>();
    for (const element of elements) {
      for (let index = element.firstIndex + 1; index <= element.lastIndex; index += 1) {
        covered.add(index);
      }
    }
    return covered;
  }, [elements]);
  const ends = useMemo(() => systemEnds(system), [system]);
  const endAt = useMemo(() => new Map(ends.map((end) => [end.index, end])), [ends]);

  /**
   * Everything in this column that carries a color, flattened to one shape so
   * the picker does not have to know whether it was opened on a piece of glass
   * or on an end of the system.
   */
  const colorTargets: ColorTarget[] = [
    ...elements.flatMap((element) =>
      element.kind === 'MIRROR'
        ? [
            {
              key: element.key,
              label: elementLabel(element, elementStyles),
              color: mirrorColor(element, elementStyles, themeMirror),
              defaultColor: themeMirror,
              isDefault: !hasChosenMirrorColor(element, elementStyles),
            },
          ]
        : element.gaps.map((gap) => ({
            key: gap.key,
            // A doublet's two halves share the element's name, so the picker says
            // which half by counting them: `L1 · 1 of 2`.
            label:
              element.gaps.length > 1
                ? `${elementLabel(element, elementStyles)} · ${element.gaps.indexOf(gap) + 1} of ${element.gaps.length}`
                : elementLabel(element, elementStyles),
            color: gapColor(gap, elementStyles),
            defaultColor: defaultGapColor(gap),
            isDefault: !hasChosenColor(gap, elementStyles),
          })),
    ),
    ...ends.map((end) => ({
      key: end.key,
      label: end.label,
      color: endColor(end, elementStyles),
      defaultColor: end.defaultColor,
      isDefault: !hasChosenEndColor(end, elementStyles),
    })),
  ];
  const openTarget = colorTargets.find((target) => target.key === colorGap);

  /**
   * The Element cell for one row: the spanning cell on an element's first row,
   * nothing at all on the rows underneath it, and an empty cell everywhere else.
   *
   * The label is a live text cell like any other, and the swatch under it opens
   * the picker. Both are view state — a `.zmx` has nowhere to put either — so
   * neither touches the system or the undo stack.
   */
  const swatch = (key: string, color: string, isDefault: boolean, what: string) => (
    <button
      type="button"
      className="element-swatch"
      style={{ background: color }}
      aria-label={`Color of ${what}`}
      title={`${what}: ${color}${isDefault ? ' (default)' : ''}. Click to change.`}
      onClick={() => setColorGap(key)}
    />
  );

  const renderElementCell = (index: number) => {
    // The span wins over everything, because it is what keeps the column's cell
    // count right. It can reach the image row — a lens whose rear face *is* the
    // image plane is a system the model allows — and IMG then has no cell of its
    // own rather than a second one fighting for the same square.
    if (coveredRows.has(index)) {
      return null; // the cell above spans this row
    }

    // The ends are not elements and cannot start one: `findElements` begins past
    // the object, and the last surface can only ever be a gap's *back* face.
    const end = endAt.get(index);
    if (end !== undefined) {
      return (
        <td className="element-cell is-end">
          <span className="end-label" title={`Surface ${index} is the ${end.label} plane.`}>
            {end.label}
          </span>
          <div className="element-swatches">
            {swatch(
              end.key,
              endColor(end, elementStyles),
              !hasChosenEndColor(end, elementStyles),
              `the ${end.label} plane`,
            )}
          </div>
        </td>
      );
    }

    const element = elementStart.get(index);
    if (element === undefined) {
      return <td className="element-cell is-empty" />;
    }
    const name = elementLabel(element, elementStyles);
    const isMirror = element.kind === 'MIRROR';
    return (
      <td className="element-cell" rowSpan={elementRowSpan(element)}>
        <TextCell
          value={name}
          ariaLabel={`Name of element ${name}`}
          title={
            isMirror
              ? 'What this mirror is called. A name of your own, or M1, M2, … in order.'
              : 'What this element is called. A name of your own, or L1, L2, … in order.'
          }
          onCommit={(next) => onElementStyle(element.key, { label: next })}
        />
        {/* One swatch per piece of glass, so the two halves of a cemented
            doublet can be told apart — they are different glasses, and both
            views already draw them as two bodies. A mirror has no glass in it
            and no body to fill, so its one color belongs to the element itself. */}
        <div className="element-swatches">
          {isMirror
            ? swatch(
                element.key,
                mirrorColor(element, elementStyles, themeMirror),
                !hasChosenMirrorColor(element, elementStyles),
                `mirror ${name}`,
              )
            : element.gaps.map((gap, gapIndex) => {
                const which =
                  element.gaps.length > 1 ? `${name}, glass ${gapIndex + 1}` : `element ${name}`;
                return (
                  <span key={gap.key}>
                    {swatch(
                      gap.key,
                      gapColor(gap, elementStyles),
                      !hasChosenColor(gap, elementStyles),
                      which,
                    )}
                  </span>
                );
              })}
        </div>
      </td>
    );
  };

  const headerIsTransform =
    highlightedSurface !== undefined &&
    highlightedSurface < system.surfaces.length &&
    system.surfaceAt(highlightedSurface).type === 'COORDINATE_TRANSFORM';

  const apply = (result: Result<OpticalSystem>): void => {
    if (result.ok) {
      setError(undefined);
      setStatus(undefined);
      onChange(result.value);
    } else {
      setError(result.error);
    }
  };

  const closeMenu = useCallback(() => setMenu(undefined), []);

  /**
   * What right-clicking a row offers.
   *
   * Above and below, in that order, because the row is between them and the
   * menu reads down the page in the direction it acts. Both are ghosted at the
   * end they cannot reach — nothing goes above the object plane and nothing
   * below the image plane — rather than left to fail on the click, and the
   * tooltip says which rule it ran into. The same guards are in `edits.ts`, so a
   * caller that never saw this menu gets the same answer.
   *
   * Delete is set apart by a rule, because it is the one item here that destroys
   * something. The two inserts are reversible by deleting what they made; this
   * one is reversible only through Undo.
   */
  const rowMenu = (index: number): MenuItem[] => {
    const last = system.surfaces.length - 1;
    const isEnd = index === 0 || index === last;
    return [
      {
        key: 'insert-above',
        label: 'Insert surface above',
        disabled: index === 0,
        hint:
          index === 0
            ? 'The object plane has to be the first surface, so nothing can go above it.'
            : `A plane air surface, which becomes surface ${index}.`,
        onSelect: () => apply(insertSurfaceBefore(system, index)),
      },
      {
        key: 'insert-below',
        label: 'Insert surface below',
        disabled: index === last,
        hint:
          index === last
            ? 'The image plane has to be the last surface, so nothing can go below it.'
            : `A plane air surface, which becomes surface ${index + 1}.`,
        onSelect: () => apply(insertSurfaceAfter(system, index)),
      },
      {
        key: 'delete',
        label: 'Delete surface',
        startsGroup: true,
        disabled: isEnd,
        // Every element is *derived* from where the glass is, so nothing has to
        // be told about this: drop the cemented interface of a doublet and what
        // is left is a run of glass across one gap, which is a singlet. Drop the
        // face the glass begins at and there is no run at all, so no element —
        // just a surface. Both fall out of `findElements` on the next render.
        hint: isEnd
          ? 'The object and image planes are what the system is measured between, so neither can be removed.'
          : `Removes surface ${index}. An element it was part of is re-read from the glass that is left.`,
        onSelect: () => apply(removeSurface(system, index)),
      },
    ];
  };

  /**
   * Runs the focus search and says what it did. The result is worth reporting
   * rather than silently applying: a thickness that barely moves is the honest
   * answer when the design is already focused, and looks like a broken button
   * otherwise.
   */
  const focus = (): void => {
    const result = quickFocus(system);
    if (!result.ok) {
      setStatus(undefined);
      setError(result.error);
      return;
    }
    const { previousRms, rms, previousThickness, thickness, surfaceIndex, droppedFields } =
      result.value;
    // Fields with no image at any focus are left out of the merit, so the number
    // does not speak for them and the user has to be told which ones.
    const caveat =
      droppedFields.length === 0
        ? ''
        : ` Field${droppedFields.length > 1 ? 's' : ''} ${droppedFields.join(', ')} ` +
          `left out: nothing of ${droppedFields.length > 1 ? 'them' : 'it'} reaches the image.`;
    setError(undefined);
    setStatus(
      (rms < previousRms
        ? `Focused on surface ${surfaceIndex}: thickness ${formatLength(previousThickness)} → ` +
          `${formatLength(thickness)}, RMS spot ${formatMicrons(previousRms)} → ${formatMicrons(rms)}.`
        : `Already at best focus: RMS spot ${formatMicrons(rms)}. Nothing moved.`) + caveat,
    );
    onChange(result.value.system);
  };

  /**
   * Makes a surface a mirror, and says what else moved.
   *
   * Turning a surface round also flips the thickness after it, because that
   * distance is measured along +Z and +Z is now behind the light. It is the
   * right thing to do — without it every ray after the mirror reports MISSED and
   * the layout simply empties — but it is a second edit the user did not type,
   * so it is reported rather than done quietly.
   */
  const mirror = (index: number): void => {
    const before = system.surfaceAt(index).thickness;
    const result = setMirror(system, index, true);
    if (!result.ok) {
      setStatus(undefined);
      setError(result.error);
      return;
    }
    setError(undefined);
    setStatus(
      `Surface ${index} is now a mirror in ${system.surfaceAt(index - 1).material.name}. ` +
        `Its thickness flipped to ${formatLength(-before)}: the light travels back the way it came.`,
    );
    onChange(result.value);
  };

  /**
   * Steps the highlight one row and moves focus with it.
   *
   * Focus follows so that the row keeps the keys — and so that an edit in
   * progress commits, since the cells commit on blur. `preventScroll` is the
   * point of the exercise: `focus()` would otherwise scroll the row into view,
   * which is the very page movement being suppressed.
   */
  const step = (delta: number): void => {
    const last = system.surfaces.length - 1;
    const next =
      highlightedSurface === undefined
        ? delta > 0
          ? 0
          : last
        : Math.min(last, Math.max(0, highlightedSurface + delta));
    onHighlight(next);
    rows.current[next]?.focus({ preventScroll: true });
  };

  const arrowKey = (key: string): number | undefined =>
    key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : undefined;

  /**
   * Arrow keys while the pointer is over the table but nothing in it has focus.
   * Without this the browser scrolls the page, and the row under a stationary
   * pointer changes — which looks like the highlight moving, but is the page
   * sliding underneath it.
   *
   * Only claimed when focus is nowhere in particular: if the user is typing in
   * a field elsewhere and the pointer happens to rest here, the keys are
   * theirs. When focus *is* inside the table, the React handler below has it.
   */
  useEffect(() => {
    if (!pointerInside) {
      return;
    }
    // The table's own document, not the app's: a panel in the second window is
    // in a document of its own, and keys pressed there never reach the opener.
    const owner = table.current?.ownerDocument ?? document;
    const onKeyDown = (event: KeyboardEvent) => {
      const delta = arrowKey(event.key);
      if (delta === undefined) {
        return;
      }
      const active = owner.activeElement;
      if (active !== null && active !== owner.body) {
        return;
      }
      event.preventDefault();
      step(delta);
    };
    owner.addEventListener('keydown', onKeyDown);
    return () => owner.removeEventListener('keydown', onKeyDown);
    // `step` is re-made every render; it is only correct to keep a listener
    // holding one while the values it closes over are unchanged.
  }, [pointerInside, highlightedSurface, system.surfaces.length, onHighlight]);

  return (
    <Panel
      title="Optical system"
      flush
      choice={choice}
      actions={
        <>
          <button
            title="Move the image plane to the smallest RMS spot, over every field and wavelength"
            onClick={focus}
          >
            Quick focus
          </button>
          <span className="hint">
            {system.surfaces.length} surfaces · {system.units}
          </span>
        </>
      }
    >
      <datalist id={MATERIAL_LIST_ID}>
        {/* MODEL and MIRROR lead the list because neither is a name to look
            up: one opens the Model glass column, the other makes the surface
            reflect. Everything below them is a real glass. */}
        <option value={MODEL_MATERIAL_LABEL} key={MODEL_MATERIAL_LABEL} />
        <option value={MIRROR_MATERIAL_LABEL} key={MIRROR_MATERIAL_LABEL} />
        {GLASS_CATALOG.names().map((name) => (
          <option value={name} key={name} />
        ))}
      </datalist>

      <div
        className="table-scroll"
        ref={table}
        onMouseEnter={() => setPointerInside(true)}
        onMouseLeave={() => setPointerInside(false)}
        onKeyDown={(event) => {
          // Arrows move between rows while focus is anywhere in the table,
          // including inside a cell being edited, which is how a lens grid is
          // expected to behave. Left and right are untouched, so text editing
          // in a cell still works.
          const delta = arrowKey(event.key);
          if (delta !== undefined) {
            event.preventDefault();
            step(delta);
          }
        }}
      >
        <table>
          {/* Explicit widths, with `table-layout: fixed` in the stylesheet, so a
              column's width never depends on what is in it. Without this the
              browser sizes columns from their contents — including header text —
              and the four shape columns collapsing to one span on a coordinate
              transform row would hand their slack to the other columns, shifting
              the whole table sideways as the cursor moved between rows. It also
              stops the table jumping when a value simply gets longer. */}
          <colgroup>
            <col className="col-surface" />
            <col className="col-element" />
            <col className="col-stop" />
            <col className="col-type" />
            <col className="col-label" />
            <col className="col-radius" />
            <col className="col-conic" />
            <col className="col-asphere" />
            <col className="col-focal" />
            <col className="col-thickness" />
            <col className="col-material" />
            <col className="col-model" />
            <col className="col-semidia" />
            <col className="col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>Surface</th>
              <th className="element-header">Element</th>
              <th>Stop</th>
              <th>Surface Type</th>
              <th className="text-column">Label</th>
              {/* A header names a whole column, so it can only speak for one row
                  while the cursor is on that row. On a coordinate transform the
                  four shape columns hold nothing, and saying "Radius" over an
                  empty span is worse than saying what is actually there. */}
              {headerIsTransform ? (
                <th colSpan={SHAPE_COLUMNS} className="transform-header">
                  Coordinate Transform
                </th>
              ) : (
                <>
                  <th>Radius</th>
                  <th>Conic</th>
                  <th>Asphere</th>
                  <th>Focal length</th>
                </>
              )}
              <th>Thickness</th>
              <th>Material</th>
              <th>Model glass</th>
              <th>Semi-dia</th>
              <th aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {system.surfaces.map((surface, index) => {
              const isObject = surface.type === 'OBJECT';
              const isImage = surface.type === 'IMAGE';
              const isParaxial = surface.type === 'PARAXIAL';
              const isTransform = surface.type === 'COORDINATE_TRANSFORM';
              const isFixed = isObject || isImage;
              const modelParameters = modelGlassText(surface.material);
              // Every surface is its own number, with no exceptions: the object
              // is 0 and the image is whatever the last one comes to. Zemax names
              // three rows here — OBJ, STO, IMA — and each name costs that row the
              // one thing the column is for. The ends are named in the Element
              // column instead, and the stop has a column of its own.
              const label = String(index);

              return (
                <tr
                  key={surface.id}
                  // Focusable only programmatically: the arrow keys land focus
                  // here, but Tab still walks the cells rather than the rows.
                  tabIndex={-1}
                  ref={(element) => {
                    rows.current[index] = element;
                  }}
                  className={index === highlightedSurface ? 'row-highlight' : undefined}
                  onMouseEnter={() => onHighlight(index)}
                  onMouseLeave={() => onHighlight(undefined)}
                  // The panel's own menu in place of the browser's. The row is
                  // named in the menu's heading because the pointer leaves it on
                  // the way there, taking the highlight with it — and a menu that
                  // inserts a surface has to say which surface it means.
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onHighlight(index);
                    setMenu({ at: { x: event.clientX, y: event.clientY }, index });
                  }}
                  onFocus={() => onHighlight(index)}
                  onBlur={(event) => {
                    // Moving between cells of the same row must not blink the
                    // highlight off and on, so only a focus leaving the row
                    // clears it. React's onBlur bubbles, unlike the DOM's.
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      onHighlight(undefined);
                    }
                  }}
                >
                  <td className="row-label" title={`Surface ${index}`}>
                    {label}
                  </td>

                  {/* One cell spanning every row of the element, so the two (or
                      three) faces of a lens read as the one thing they are.
                      Rows inside the span render no cell at all — that is what
                      rowSpan means — and a row belonging to no element gets an
                      empty one to keep the column aligned. */}
                  {renderElementCell(index)}

                  {/* Beside the row's identity rather than out past the glass:
                      which surface is the stop is a fact about the *system*, like
                      the surface's number and the element it belongs to, and it
                      was the one such fact stranded at the far end of a table
                      that has to be scrolled. */}
                  <td className="stop-cell">
                    <input
                      type="radio"
                      name="stop-surface"
                      checked={surface.isStop}
                      disabled={isFixed}
                      aria-label={`Make surface ${label} the aperture stop`}
                      onChange={() => apply(setStop(system, index))}
                    />
                  </td>

                  <td>
                    <SurfaceTypeCell
                      type={surface.type}
                      fixed={isFixed}
                      ariaLabel={`Type of surface ${label}`}
                      onChange={(next) => apply(setSurfaceType(system, index, next))}
                    />
                  </td>

                  <td className="text-column">
                    <TextCell
                      value={surface.comment ?? ''}
                      placeholder="—"
                      ariaLabel={`Label for surface ${label}`}
                      title="A note naming this surface. Imported from and written as Zemax's COMM record."
                      onCommit={(next) => apply(updateSurface(system, index, { comment: next }))}
                    />
                  </td>

                  {/* A coordinate transform has none of the four things these
                      columns hold — no radius, no conic, no polynomial, no focal
                      length — so on its row they become one field carrying the
                      thing it does have. The header follows suit while the cursor
                      is on the row, which is the only time a shared header can
                      honestly name one row's contents. */}
                  {isTransform ? (
                    <td colSpan={SHAPE_COLUMNS} className="transform-cell">
                      {surface.coordinateTransform !== undefined ? (
                        <CoordinateTransformSummaryButton
                          parameters={surface.coordinateTransform}
                          surfaceLabel={label}
                          onOpen={() => setTransformSurface(index)}
                        />
                      ) : null}
                    </td>
                  ) : (
                    <>
                      {/* Radius and focal length are the two ways a surface can
                          carry power, and no surface has both; the inapplicable
                          one is blank. */}
                      <td>
                        {isParaxial ? (
                          <EmptyCell reason="A paraxial surface is a plane; its power is its focal length." />
                        ) : (
                          <NumericCell
                            value={surface.radius}
                            ariaLabel={`Radius of surface ${label}`}
                            title="Radius of curvature. 0 or blank means flat."
                            disabled={isFixed}
                            onCommit={(next) =>
                              apply(
                                updateSurface(system, index, {
                                  radius: normalizeRadius(next),
                                }),
                              )
                            }
                          />
                        )}
                      </td>

                      {/* Conic sits beside the radius because the two together
                          are the surface's shape: the radius is where it starts,
                          the conic is how it departs from a sphere. */}
                      <td>
                        {isParaxial ? (
                          <EmptyCell reason="A paraxial surface is a plane; it has no conic constant." />
                        ) : (
                          <NumericCell
                            value={surface.conic}
                            ariaLabel={`Conic constant of surface ${label}`}
                            title="Conic constant k. 0 sphere, −1 paraboloid, below −1 hyperboloid, between −1 and 0 ellipsoid."
                            onCommit={(next) =>
                              apply(updateSurface(system, index, { conic: next }))
                            }
                          />
                        )}
                      </td>

                      <td>
                        {surface.type === 'EVEN_ASPHERE' ? (
                          <AsphericSummaryButton
                            coefficients={surface.asphericCoefficients}
                            surfaceLabel={label}
                            onOpen={() => setAsphereSurface(index)}
                          />
                        ) : (
                          <EmptyCell reason="Set the surface type to EVEN_ASPHERE to give it aspheric coefficients." />
                        )}
                      </td>

                      <td>
                        {isParaxial ? (
                          <NumericCell
                            value={surface.focalLength ?? 0}
                            ariaLabel={`Focal length of surface ${label}`}
                            title="Focal length of the ideal thin lens. Negative diverges."
                            onCommit={(next) =>
                              apply(updateSurface(system, index, { focalLength: next }))
                            }
                          />
                        ) : (
                          <EmptyCell reason="Only a paraxial surface has a focal length." />
                        )}
                      </td>
                    </>
                  )}

                  <td>
                    <NumericCell
                      value={surface.thickness}
                      ariaLabel={`Thickness after surface ${label}`}
                      title="Distance to the next surface. The object may be Infinity."
                      disabled={isImage}
                      onCommit={(next) => apply(updateSurface(system, index, { thickness: next }))}
                    />
                  </td>

                  <td>
                    {/* Zemax writes "-" here for a transform, because a transform cannot
                        be a boundary between two media: it carries whatever the
                        surface before it did, and the model refuses anything
                        else. Showing a blank editable cell would invite an edit
                        that could only be rejected. */}
                    {isTransform ? (
                      <EmptyCell reason="A coordinate transform carries the medium before it; it cannot be a boundary between two media." />
                    ) : (
                      <MaterialCell
                        material={surface.material}
                        reflective={surface.reflective}
                        ariaLabel={`Material after surface ${label}`}
                        disabled={isImage || isParaxial}
                        onCommit={(material) =>
                          apply(
                            surface.reflective
                              ? // Leaving MIRROR: drop the reflection first, so the
                                // new medium is applied to a refracting surface
                                // rather than to one the model still calls a mirror.
                                chain(setMirror(system, index, false), (next) =>
                                  updateSurface(next, index, { material }),
                                )
                              : updateSurface(system, index, { material }),
                          )
                        }
                        onMirror={() => mirror(index)}
                      />
                    )}
                  </td>

                  {/* The parameters of a glass given by numbers rather than by
                      name; blank for air and for anything in the catalog. */}
                  <td>
                    {modelParameters === undefined ? (
                      <EmptyCell reason="Set the material to MODEL to give a glass by index and Abbe number." />
                    ) : (
                      <ModelGlassCell
                        text={modelParameters}
                        ariaLabel={`Model glass parameters of surface ${label}`}
                        disabled={isImage}
                        onCommit={(material) => apply(updateSurface(system, index, { material }))}
                      />
                    )}
                  </td>

                  <td>
                    {isTransform ? (
                      <EmptyCell reason="A coordinate transform meets no ray, so it has no clear aperture." />
                    ) : (
                      <NumericCell
                        value={surface.semiDiameter}
                        ariaLabel={`Semi-diameter of surface ${label}`}
                        title="Clear aperture radius. 0 or blank means unapertured."
                        onCommit={(next) =>
                          apply(
                            updateSurface(system, index, {
                              semiDiameter: normalizeSemiDiameter(next),
                            }),
                          )
                        }
                      />
                    )}
                  </td>

                  <td>
                    <button
                      className="subtle"
                      title="Insert a surface after this one"
                      aria-label={`Insert a surface after ${label}`}
                      onClick={() => apply(insertSurfaceAfter(system, index))}
                    >
                      +
                    </button>
                    <button
                      className="subtle"
                      title="Delete this surface"
                      aria-label={`Delete surface ${label}`}
                      disabled={isFixed}
                      onClick={() => apply(removeSurface(system, index))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error ? (
        <div style={{ padding: '10px 12px' }}>
          <ErrorNote message={error} />
        </div>
      ) : null}

      {status ? (
        <p className="hint" style={{ padding: '10px 12px', margin: 0 }}>
          {status}
        </p>
      ) : null}

      {menu === undefined ? null : (
        <ContextMenu
          // Keyed on the row, so right-clicking a second row while the first
          // menu is still up re-measures and re-places it rather than leaving it
          // where the last one was.
          key={menu.index}
          at={menu.at}
          heading={`Surface ${menu.index}`}
          items={rowMenu(menu.index)}
          onClose={closeMenu}
        />
      )}

      {openTarget !== undefined ? (
        <ElementColorPicker
          key={openTarget.key}
          label={openTarget.label}
          color={openTarget.color}
          isDefault={openTarget.isDefault}
          defaultColor={openTarget.defaultColor}
          inUse={colorsInUse(elements, elementStyles, ends, themeMirror)}
          onPick={(color) => onElementStyle(openTarget.key, { color })}
          onReset={() => onElementStyle(openTarget.key, { color: undefined })}
          onClose={() => setColorGap(undefined)}
        />
      ) : null}

      {asphereSurface !== undefined && system.surfaces[asphereSurface] ? (
        <AsphericCoefficientsDialog
          // Keyed on the surface so opening a different row rebuilds the dialog
          // rather than carrying the previous row's "add term" state across.
          key={system.surfaceAt(asphereSurface).id}
          surfaceLabel={String(asphereSurface)}
          coefficients={system.surfaceAt(asphereSurface).asphericCoefficients}
          onCommit={(asphericCoefficients) =>
            apply(updateSurface(system, asphereSurface, { asphericCoefficients }))
          }
          onClose={() => setAsphereSurface(undefined)}
        />
      ) : null}

      {transformSurface !== undefined &&
      system.surfaceAt(transformSurface).coordinateTransform !== undefined ? (
        <CoordinateTransformDialog
          key={system.surfaceAt(transformSurface).id}
          surfaceLabel={String(transformSurface)}
          parameters={system.surfaceAt(transformSurface).coordinateTransform!}
          anchor={table}
          onCommit={(changes) =>
            apply(updateCoordinateTransform(system, transformSurface, changes))
          }
          onClose={() => setTransformSurface(undefined)}
        />
      ) : null}
    </Panel>
  );
}

/**
 * The four columns that describe a surface's shape and power: radius, conic,
 * parameters, focal length. A coordinate transform has none of them, so on its
 * row they are spanned by the one field it does have.
 */
const SHAPE_COLUMNS = 4;

/** The types a user may pick between, in the order they appear in the dropdown. */
const EDITABLE_SURFACE_TYPES: readonly EditableSurfaceType[] = [
  'STANDARD',
  'EVEN_ASPHERE',
  'PARAXIAL',
  'COORDINATE_TRANSFORM',
];

/**
 * Surface type. OBJECT and IMAGE are fixed by their position in the system, so
 * they are shown as text rather than offered as choices that would be refused.
 */
function SurfaceTypeCell({
  type,
  fixed,
  ariaLabel,
  onChange,
}: {
  type: string;
  fixed: boolean;
  ariaLabel: string;
  onChange: (type: EditableSurfaceType) => void;
}) {
  if (fixed) {
    return (
      <span className="fixed-type" title="The ends of the system are fixed by position.">
        {type}
      </span>
    );
  }

  return (
    <select
      value={type}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value as EditableSurfaceType)}
    >
      {EDITABLE_SURFACE_TYPES.map((name) => (
        <option value={name} key={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

/** A column that does not apply to this surface type. */
function EmptyCell({ reason }: { reason: string }) {
  return (
    <span className="empty-cell" title={reason} aria-label={reason}>
      —
    </span>
  );
}

/**
 * The medium after a surface: a catalog name, blank for air, or MODEL for a
 * glass given by its numbers, which the Model glass column then carries.
 * Validated as you type and committed on the way out, so a name that is not a
 * glass is shown as wrong rather than applied.
 */
function MaterialCell({
  material,
  reflective,
  ariaLabel,
  disabled,
  onCommit,
  onMirror,
}: {
  material: Material;
  reflective: boolean;
  ariaLabel: string;
  disabled: boolean;
  onCommit: (material: Material) => void;
  onMirror: () => void;
}) {
  const label = materialLabel(material, reflective);
  const [draft, setDraft] = useState(label);
  const [editing, setEditing] = useState(false);
  const shown = editing ? draft : label;
  const wantsMirror = isMirrorText(shown);
  const resolved = wantsMirror ? material : materialFromText(shown, material);

  return (
    <input
      list={MATERIAL_LIST_ID}
      value={shown}
      disabled={disabled}
      placeholder="air"
      aria-label={ariaLabel}
      className={resolved ? undefined : 'invalid'}
      title={
        resolved
          ? `A catalog glass name, blank for air, ${MODEL_MATERIAL_LABEL} for a glass given by ` +
            `index and Abbe number, or ${MIRROR_MATERIAL_LABEL} to reflect. A mirror keeps the ` +
            'medium it is in and reverses the thickness after it.'
          : `"${shown.trim()}" is not in the catalog`
      }
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => {
        setDraft(label);
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        if (isMirrorText(draft)) {
          // MIRROR is not a medium, so it does not go through onCommit: the
          // surface's medium and thickness both have to move with it.
          if (!reflective) {
            onMirror();
          }
          return;
        }
        const next = materialFromText(draft, material);
        // Compared by identity: MODEL over a model glass returns the same glass,
        // and re-committing it would put an identical design on the undo stack.
        // A surface leaving MIRROR still commits, even to the same medium, since
        // what changes there is the reflection rather than the material.
        if (next && (next !== material || reflective)) {
          onCommit(next);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * The parameters of a model glass — `nd / Vd`, and ΔPg,F when it has one. One
 * cell rather than three columns, because the three numbers are read and quoted
 * together, and two of them are blank on most rows of a real design.
 */
function ModelGlassCell({
  text,
  ariaLabel,
  disabled,
  onCommit,
}: {
  text: string;
  ariaLabel: string;
  disabled: boolean;
  onCommit: (material: Material) => void;
}) {
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  const shown = editing ? draft : text;
  const parsed = modelGlassFromText(shown);

  return (
    <input
      className={parsed.ok ? 'parameters' : 'parameters invalid'}
      value={shown}
      disabled={disabled}
      aria-label={ariaLabel}
      title={parsed.ok ? MODEL_GLASS_HINT : parsed.error}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => {
        setDraft(text);
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        // On the text, not the material: parsing the unchanged cell builds an
        // equal-but-distinct glass, which would re-render the whole design and
        // push an undo step for a cell the user only passed through.
        if (draft.trim() === text.trim()) {
          return;
        }
        const material = modelGlassFromText(draft);
        if (material.ok) {
          onCommit(material.value);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
