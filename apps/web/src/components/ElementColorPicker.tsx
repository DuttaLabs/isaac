import { useEffect, useRef, useState } from 'react';
import { ELEMENT_PALETTE } from '../lib/elements.ts';

/**
 * The color one element is drawn in, chosen from a modal.
 *
 * A popover would sit better under the swatch, but the lens table scrolls in
 * both directions and a popover anchored inside it has to be re-positioned on
 * every scroll or it drifts off its own button. A `<dialog>` is the same
 * machinery the aspheric terms already use here, and `showModal()` brings the
 * focus trap, the backdrop and Escape with it — none of which the `open`
 * attribute gives.
 *
 * Three ways to choose, in the order they are reached for:
 *
 * - **Already used in this design.** The reason the row exists: a design with
 *   two doublets usually wants both doublets the same color, and matching a hex
 *   by eye is exactly the kind of thing a computer should be doing.
 * - **The palette**, for a color nothing has yet.
 * - **A custom one**, through the platform's own color input — which is the
 *   operating system's full RGB picker, so any color at all is reachable today,
 *   just not from inside this dialog.
 *
 * Choosing applies immediately, like a table cell, so the layout behind the
 * dialog repaints as the user tries colors rather than after they commit.
 */
export function ElementColorPicker({
  label,
  color,
  isDefault,
  defaultColor,
  inUse,
  onPick,
  onReset,
  onClose,
}: {
  /** What this piece of glass is called — `L1`, or `L1 · 1 of 2` for a doublet half. */
  label: string;
  /** The color it is drawn in now, chosen or default. Never absent: everything has one. */
  color: string;
  /** True while that color is still the one it started with. */
  isDefault: boolean;
  /** The color it started with, for the button that puts it back. */
  defaultColor: string;
  /** Colors this design already uses, offered for reuse. */
  inUse: readonly string[];
  onPick: (color: string) => void;
  /** Drops the override, so the element goes back to its default color. */
  onReset: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [custom, setCustom] = useState(color);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) {
      element.showModal();
    }
  }, []);

  const swatch = (value: string, key: string) => (
    <button
      key={key}
      type="button"
      className={`color-swatch${sameColor(value, color) ? ' is-chosen' : ''}`}
      style={{ background: value }}
      title={value}
      aria-label={value}
      aria-pressed={sameColor(value, color)}
      onClick={() => {
        setCustom(value);
        onPick(value);
      }}
    />
  );

  return (
    <dialog
      ref={dialog}
      className="color-dialog"
      aria-label={`Color of element ${label}`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          dialog.current?.close();
        }
      }}
    >
      <header>
        <h2>Color · {label}</h2>
        <button className="subtle" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </header>

      {inUse.length > 0 && (
        <section>
          <h3>Already in this design</h3>
          <div className="color-row">{inUse.map((value) => swatch(value, `used-${value}`))}</div>
        </section>
      )}

      <section>
        <h3>Palette</h3>
        <div className="color-row">
          {ELEMENT_PALETTE.map((value) => swatch(value, `palette-${value}`))}
        </div>
      </section>

      <section>
        <h3>Custom</h3>
        <div className="color-custom">
          <input
            type="color"
            value={custom}
            aria-label={`Custom color for element ${label}`}
            onChange={(event) => {
              setCustom(event.target.value);
              onPick(event.target.value);
            }}
          />
          <code>{color}</code>
          <button className="subtle" onClick={onReset} disabled={isDefault} title={defaultColor}>
            Reset to default
          </button>
        </div>
      </section>
    </dialog>
  );
}

/** Hex is case-insensitive, and the platform's color input answers in lower case. */
function sameColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
