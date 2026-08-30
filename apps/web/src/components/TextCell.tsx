import { useEffect, useRef, useState } from 'react';

/**
 * A free-text table cell that keeps a draft while focused and commits on blur
 * or Enter, so a re-render mid-typing cannot swallow the edit. Escape restores
 * the stored value.
 */
export function TextCell({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  title,
  focusOnOpen,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  /**
   * For a box that appears *in order to be typed in* — the layout rename. It
   * takes focus and **selects what is there**, so the first keystroke replaces
   * the old name rather than being appended to it, which is what a rename box
   * opened by a menu item is asking for.
   */
  focusOnOpen?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // On mount only: the box has just been opened, and re-selecting mid-typing
  // would eat every keystroke after the first.
  useEffect(() => {
    if (focusOnOpen === true) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focusOnOpen]);

  // Adopt external changes (undo, file load) unless the user is mid-edit.
  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [value, editing]);

  const commit = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) {
      onCommit(next);
    }
  };

  return (
    <input
      ref={input}
      className="text-input"
      value={editing ? draft : value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      title={title}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => {
        setDraft(value);
        setEditing(true);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setEditing(false);
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
