import { useEffect, useState } from 'react';
import { formatLength, parseLength } from '../lib/format.ts';

/**
 * A numeric field that keeps its own draft while focused, so half-typed values
 * like "-" or "1." are not parsed and thrown away on every keystroke. The edit
 * commits on blur or Enter, and Escape restores the value from the model.
 */
export function NumericCell({
  value,
  onCommit,
  disabled = false,
  title,
  ariaLabel,
}: {
  value: number;
  onCommit: (next: number) => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}) {
  const formatted = formatLength(value);
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);

  // Adopt external changes (undo, file load, a solve) unless mid-edit.
  useEffect(() => {
    if (!editing) {
      setDraft(formatted);
    }
  }, [formatted, editing]);

  const commit = (): void => {
    setEditing(false);
    const parsed = parseLength(draft, value);
    if (parsed !== value) {
      onCommit(parsed);
    } else {
      setDraft(formatted);
    }
  };

  return (
    <input
      className="numeric"
      value={draft}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setEditing(false);
          setDraft(formatted);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
