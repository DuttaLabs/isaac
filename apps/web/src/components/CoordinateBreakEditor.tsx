import { useEffect, useRef, useState } from 'react';
import type { CoordinateBreak } from '@isaac/optical-core';
import { formatLength, parseLength } from '../lib/format.ts';

/**
 * The five numbers, in the order the file writes them and the order a designer
 * reads them: where the axis moves to, then how it turns.
 */
const FIELDS: readonly {
  key: keyof Omit<CoordinateBreak, 'tiltFirst'>;
  label: string;
  unit: 'length' | 'degrees';
  hint: string;
}[] = [
  {
    key: 'decenterX',
    label: 'Decenter X',
    unit: 'length',
    hint: 'Shift of the axis along local x.',
  },
  {
    key: 'decenterY',
    label: 'Decenter Y',
    unit: 'length',
    hint: 'Shift of the axis along local y.',
  },
  {
    key: 'tiltXDeg',
    label: 'Tilt about X',
    unit: 'degrees',
    hint: 'Right-handed rotation about local x. This is the one a fold mirror uses.',
  },
  {
    key: 'tiltYDeg',
    label: 'Tilt about Y',
    unit: 'degrees',
    hint: 'Right-handed rotation about local y.',
  },
  {
    key: 'tiltZDeg',
    label: 'Tilt about Z',
    unit: 'degrees',
    hint: 'Right-handed rotation about the axis itself — a roll, which a rotationally symmetric surface does not notice.',
  },
];

/**
 * The decenter and tilt of one coordinate break, in a modal rather than in the
 * lens table.
 *
 * Six more columns would push radius, thickness and glass off the side of the
 * screen, and they would be empty on every surface that is not a break — which
 * is nearly all of them. So the table keeps one cell summarizing the break, the
 * same arrangement the aspheric coefficients use, and for the same reason.
 *
 * Editing is live: each committed field produces a new system exactly as a table
 * cell does, so the layout follows along behind the open dialog and an undo
 * steps back through the numbers one at a time.
 */
export function CoordinateBreakDialog({
  surfaceLabel,
  parameters,
  onCommit,
  onClose,
}: {
  surfaceLabel: string;
  parameters: CoordinateBreak;
  onCommit: (changes: Partial<CoordinateBreak>) => void;
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

  return (
    <dialog
      ref={dialog}
      className="asphere-dialog"
      aria-label={`Coordinate break of surface ${surfaceLabel}`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          dialog.current?.close();
        }
      }}
    >
      <header>
        <h2>Coordinate break · surface {surfaceLabel}</h2>
        <button className="subtle" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </header>

      <p className="hint">
        Re-points the axis for every surface after this one. The break itself has no shape and meets
        no ray; its thickness moves along the axis <em>as re-pointed</em>.
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
          mean — so it gets a sentence rather than a row in the same table. */}
      <p className="hint">
        <label>
          <input
            type="checkbox"
            checked={parameters.tiltFirst}
            aria-label={`Tilt before decentering on surface ${surfaceLabel}`}
            onChange={(event) => onCommit({ tiltFirst: event.target.checked })}
          />{' '}
          Tilt first, then decenter
        </label>
        <br />
        {parameters.tiltFirst
          ? 'Tilts about z, then the new y, then the new x; the decenters follow, along the axes as turned. This order is what lets one break undo another.'
          : 'Decenters first, then tilts about x, then the new y, then the new z. The usual order, and what a file writes as 0.'}
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

/** One value of a break. Lengths and angles both read as plain decimals here. */
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
 * The lens-table cell that opens the dialog: a summary of the break, so the
 * table still says at a glance which surfaces move the axis and how far.
 *
 * A break with nothing set is drawn as flat rather than as zeros, because that
 * is a real and common state — the surface is added first and aimed afterwards.
 */
export function CoordinateBreakSummaryButton({
  parameters,
  surfaceLabel,
  onOpen,
}: {
  parameters: CoordinateBreak;
  surfaceLabel: string;
  onOpen: () => void;
}) {
  const tilts = [parameters.tiltXDeg, parameters.tiltYDeg, parameters.tiltZDeg];
  const decenters = [parameters.decenterX, parameters.decenterY];
  const tilted = tilts.some((value) => value !== 0);
  const decentered = decenters.some((value) => value !== 0);

  const parts: string[] = [];
  if (tilted) {
    const axes = ['X', 'Y', 'Z'].filter((_, index) => tilts[index] !== 0);
    const only =
      axes.length === 1 ? `${formatLength(tilts.find((v) => v !== 0)!)}°` : `${axes.length} tilts`;
    parts.push(axes.length === 1 ? `${axes[0]} ${only}` : only);
  }
  if (decentered) {
    parts.push('decentred');
  }

  return (
    <button
      className="asphere-summary"
      onClick={onOpen}
      aria-label={`Edit the coordinate break of surface ${surfaceLabel}`}
      title="Decenter and tilt of this coordinate break"
    >
      {parts.length === 0 ? 'flat' : parts.join(', ')}
    </button>
  );
}
