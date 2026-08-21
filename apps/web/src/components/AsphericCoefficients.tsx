import { useEffect, useRef, useState } from 'react';
import { formatCoefficient, parseCoefficient } from '../lib/format.ts';

/**
 * Zemax's even asphere carries eight coefficients, so eight rows are always
 * offered even when a design uses two. Fewer would hide the shape of the series;
 * more are added on request, since nothing in the model caps the order.
 */
const STANDARD_TERM_COUNT = 8;

/** Superscript digits, so `r^10` reads as r¹⁰ without a layout engine. */
const SUPERSCRIPTS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

function power(exponent: number): string {
  return `r${String(exponent)
    .split('')
    .map((digit) => SUPERSCRIPTS[Number(digit)])
    .join('')}`;
}

/**
 * The aspheric coefficients of one surface, in a modal rather than in the lens
 * table.
 *
 * Eight more columns would push everything a designer reads constantly —
 * radius, thickness, glass — off the side of the screen for the sake of numbers
 * that are set once and then optimized. So the table keeps a single cell
 * summarizing the series, and the terms themselves live here, where there is
 * room to label each by the power it multiplies.
 *
 * Editing is live: each committed field produces a new system exactly as a table
 * cell does, so the layout and the plots follow along behind the open dialog and
 * an undo steps back through the terms one at a time.
 *
 * When surface parameters become optimization variables, this is where the r⁴
 * and r⁶ terms get their "variable" toggles — the row already exists and already
 * knows which coefficient it is.
 */
export function AsphericCoefficientsDialog({
  surfaceLabel,
  coefficients,
  onCommit,
  onClose,
}: {
  surfaceLabel: string;
  coefficients: readonly number[];
  onCommit: (next: number[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [extraTerms, setExtraTerms] = useState(0);

  // `showModal` is what makes the element modal: it is the only way to get the
  // focus trap, the backdrop, and Escape-to-close, none of which are implied by
  // the `open` attribute.
  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) {
      element.showModal();
    }
  }, []);

  const rows = Math.max(STANDARD_TERM_COUNT, coefficients.length) + extraTerms;
  const shown = Array.from({ length: rows }, (_, index) => coefficients[index] ?? 0);

  const setTerm = (index: number, value: number): void => {
    const next = [...shown];
    next[index] = value;
    onCommit(next);
  };

  return (
    <dialog
      ref={dialog}
      className="asphere-dialog"
      aria-label={`Aspheric coefficients of surface ${surfaceLabel}`}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself, never on
      // anything inside it, which is how the two are told apart.
      onClick={(event) => {
        if (event.target === dialog.current) {
          dialog.current?.close();
        }
      }}
    >
      <header>
        <h2>Aspheric coefficients · surface {surfaceLabel}</h2>
        <button className="subtle" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </header>

      <p className="hint">
        Sag is the conic surface plus these terms:
        <br />
        <span className="formula">z = cr²/(1 + √(1 − (1+k)c²r²)) + α₁r² + α₂r⁴ + …</span>
        <br />
        Blank is zero.
      </p>

      <table className="asphere-terms">
        <thead>
          <tr>
            <th>Term</th>
            <th>Power</th>
            <th>Coefficient</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((value, index) => (
            <tr key={index}>
              <td className="row-label">α{index + 1}</td>
              <td className="row-label">{power(2 * (index + 1))}</td>
              <td>
                <CoefficientCell
                  value={value}
                  ariaLabel={`Coefficient on ${power(2 * (index + 1))} of surface ${surfaceLabel}`}
                  onCommit={(next) => setTerm(index, next)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* α₁ multiplies r², the same power the base curvature contributes, so it
          is the one term that moves the focal length rather than correcting
          aberration. Worth saying, because it surprises people. */}
      {shown[0] !== 0 ? (
        <p className="hint warning-note">
          α1 is an r² term, so it changes this surface&rsquo;s power — the first-order focal length
          is no longer the one the radius alone implies.
        </p>
      ) : null}

      <footer>
        <button className="subtle" onClick={() => setExtraTerms(extraTerms + 1)}>
          Add term
        </button>
        <button
          className="subtle"
          disabled={coefficients.length === 0}
          onClick={() => onCommit([])}
        >
          Clear all
        </button>
        <button onClick={() => dialog.current?.close()}>Done</button>
      </footer>
    </dialog>
  );
}

/**
 * One coefficient. Separate from `NumericCell` because these are not lengths:
 * they are printed and typed in scientific notation, and a blank means the term
 * is absent rather than unchanged.
 */
function CoefficientCell({
  value,
  ariaLabel,
  onCommit,
}: {
  value: number;
  ariaLabel: string;
  onCommit: (next: number) => void;
}) {
  const formatted = formatCoefficient(value);
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
        const parsed = parseCoefficient(draft, value);
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
 * The lens-table cell that opens the dialog: a summary of the series, so the
 * table still says at a glance which surfaces are aspheric and how far the
 * polynomial runs.
 */
export function AsphericSummaryButton({
  coefficients,
  surfaceLabel,
  onOpen,
}: {
  coefficients: readonly number[];
  surfaceLabel: string;
  onOpen: () => void;
}) {
  const terms = coefficients.filter((coefficient) => coefficient !== 0).length;
  const highest = coefficients.length === 0 ? 0 : 2 * coefficients.length;
  return (
    <button
      className="asphere-summary"
      aria-label={`Edit the aspheric coefficients of surface ${surfaceLabel}`}
      title={
        terms === 0
          ? 'No aspheric terms yet — the surface is its conic base. Click to add them.'
          : `${terms} term${terms > 1 ? 's' : ''}, out to ${power(highest)}. Click to edit.`
      }
      onClick={onOpen}
    >
      {terms === 0 ? 'none' : `${terms} · to ${power(highest)}`}
    </button>
  );
}
