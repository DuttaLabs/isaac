import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CoordinateTransform } from '@isaac/optical-core';
import { formatLength, parseLength } from '../lib/format.ts';

/**
 * The five numbers, in the order the file writes them and the order a designer
 * reads them: where the axis moves to, then how it turns.
 *
 * The labels are `Translate` and `Rotate` — what the numbers do to the frame.
 * The model keeps the file's own words for the fields themselves (`decenterX`,
 * `tiltXDeg`), because that is what the `.zmx` and the Zemax manual call them
 * and the reader has to speak their language.
 */
const FIELDS: readonly {
  key: keyof Omit<CoordinateTransform, 'tiltFirst'>;
  label: string;
  unit: 'length' | 'degrees';
  hint: string;
}[] = [
  {
    key: 'decenterX',
    label: 'Translate X',
    unit: 'length',
    hint: 'Shift of the axis along local x.',
  },
  {
    key: 'decenterY',
    label: 'Translate Y',
    unit: 'length',
    hint: 'Shift of the axis along local y.',
  },
  {
    key: 'tiltXDeg',
    label: 'Rotate X',
    unit: 'degrees',
    hint: 'Right-handed rotation about local x. This is the one a fold mirror uses.',
  },
  {
    key: 'tiltYDeg',
    label: 'Rotate Y',
    unit: 'degrees',
    hint: 'Right-handed rotation about local y.',
  },
  {
    key: 'tiltZDeg',
    label: 'Rotate Z',
    unit: 'degrees',
    hint: 'Right-handed rotation about the axis itself — a roll, which a rotationally symmetric surface does not notice.',
  },
];

/**
 * The decenter and tilt of one coordinate transform, in a modal rather than in the
 * lens table.
 *
 * Six more columns would push radius, thickness and glass off the side of the
 * screen, and they would be empty on every surface that is not a transform — which
 * is nearly all of them. So the table keeps one cell summarizing the transform, the
 * same arrangement the aspheric coefficients use, and for the same reason.
 *
 * Editing is live: each committed field produces a new system exactly as a table
 * cell does, so the layout follows along behind the open dialog and an undo
 * steps back through the numbers one at a time. That is the whole point of
 * `anchor`: a modal centres itself in the viewport, which would sit the dialog
 * squarely over the layout — the one panel you open it to watch. Centring it on
 * the editor instead leaves the layout clear.
 */
export function CoordinateTransformDialog({
  surfaceLabel,
  parameters,
  anchor,
  onCommit,
  onClose,
}: {
  surfaceLabel: string;
  parameters: CoordinateTransform;
  /** Element to centre on — the editor panel, so the layout stays visible. */
  anchor: RefObject<HTMLElement | null>;
  onCommit: (changes: Partial<CoordinateTransform>) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  // `showModal` is what makes the element modal: the focus trap, the backdrop
  // and Escape-to-close are none of them implied by the `open` attribute.
  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) {
      element.showModal();
    }
  }, []);

  // Measured rather than computed from a breakpoint, because the two panes are
  // a fluid grid and the editor's width follows the window. Re-measured on
  // resize so an open dialog does not end up stranded over the layout.
  useEffect(() => {
    const place = (): void => {
      const element = dialog.current;
      const target = anchor.current;
      if (element === null || target === null) {
        return;
      }
      const panel = target.getBoundingClientRect();
      const centre = panel.left + panel.width / 2;
      // Clamped so a narrow window cannot push the dialog off the left edge.
      element.style.left = `${Math.max(8, centre - element.offsetWidth / 2)}px`;
    };

    place();
    // The window the dialog is in, which is the second one when the editor has
    // been sent there — and it is that window's resize the placement follows.
    const view = dialog.current?.ownerDocument.defaultView ?? window;
    view.addEventListener('resize', place);
    return () => view.removeEventListener('resize', place);
  }, [anchor]);

  return (
    <dialog
      ref={dialog}
      className="asphere-dialog anchored-dialog"
      aria-label={`Coordinate transform of surface ${surfaceLabel}`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          dialog.current?.close();
        }
      }}
    >
      <header>
        <h2>Coordinate transform · surface {surfaceLabel}</h2>
        <button className="subtle" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </header>

      <p className="hint">
        Re-points the axis for every surface after this one. The surface itself has no shape and
        meets no ray; its thickness moves along the axis <em>as re-pointed</em>.
      </p>

      <table className="asphere-terms">
        <tbody>
          {FIELDS.map((field) => (
            <tr key={field.key}>
              <td className="row-label" title={field.hint}>
                {field.label}
              </td>
              <td className="row-label">{field.unit === 'degrees' ? '°' : ''}</td>
              <td>
                <BreakValueCell
                  value={parameters[field.key]}
                  ariaLabel={`${field.label} of surface ${surfaceLabel}`}
                  onCommit={(next) => onCommit({ [field.key]: next })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* The order flag is not a sixth quantity — it changes what the other five
          mean — so it sits outside the table rather than as a row in it. */}
      <p className="hint">
        <label>
          <input
            type="checkbox"
            checked={parameters.tiltFirst}
            aria-label={`Rotate before translating on surface ${surfaceLabel}`}
            onChange={(event) => onCommit({ tiltFirst: event.target.checked })}
          />{' '}
          Rotate first, then translate
        </label>
      </p>

      <footer>
        <button
          className="subtle"
          onClick={() =>
            onCommit({
              decenterX: 0,
              decenterY: 0,
              tiltXDeg: 0,
              tiltYDeg: 0,
              tiltZDeg: 0,
            })
          }
        >
          Clear all
        </button>
        <button onClick={() => dialog.current?.close()}>Done</button>
      </footer>
    </dialog>
  );
}

/** One value of a transform. Lengths and angles both read as plain decimals here. */
function BreakValueCell({
  value,
  ariaLabel,
  onCommit,
}: {
  value: number;
  ariaLabel: string;
  onCommit: (next: number) => void;
}) {
  const formatted = formatLength(value);
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraft(formatted);
    }
  }, [formatted, editing]);

  return (
    <input
      className="numeric coefficient"
      value={draft}
      placeholder="0"
      aria-label={ariaLabel}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false);
        const parsed = parseLength(draft, value);
        if (parsed !== value) {
          onCommit(parsed);
        } else {
          setDraft(formatted);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          // Escape belongs to the field while it is being edited; only an
          // unedited field lets it through to close the dialog.
          if (draft !== formatted) {
            event.stopPropagation();
            event.preventDefault();
          }
          setEditing(false);
          setDraft(formatted);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * The lens-table cell that opens the dialog: the transform's own numbers, so the
 * table says at a glance which surfaces move the axis and by how much.
 *
 * Written out in full — zeros included — rather than summarized. The five
 * numbers are the whole content of the surface, they fit in the span the four
 * shape columns leave behind, and a reader comparing two transform rows wants
 * them in the same places both times.
 */
export function CoordinateTransformSummaryButton({
  parameters,
  surfaceLabel,
  onOpen,
}: {
  parameters: CoordinateTransform;
  surfaceLabel: string;
  onOpen: () => void;
}) {
  const { decenterX, decenterY, tiltXDeg, tiltYDeg, tiltZDeg } = parameters;
  // `formatLength` already prints 0 as "0" and drops trailing zeros, so the
  // numbers read the way they were typed.
  const translate = [decenterX, decenterY].map((value) => formatLength(value)).join(', ');
  const rotate = [tiltXDeg, tiltYDeg, tiltZDeg].map((value) => formatLength(value)).join(', ');

  return (
    <button
      className="asphere-summary"
      onClick={onOpen}
      aria-label={`Edit the coordinate transform of surface ${surfaceLabel}`}
      title="Translation and rotation of this coordinate transform"
    >
      {`Translate (${translate}), Rotate (${rotate})`}
    </button>
  );
}
