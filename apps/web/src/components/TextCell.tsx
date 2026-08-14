import { useEffect, useState } from 'react';

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
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

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
