import type { ReactNode } from 'react';
import { PANELS, PANEL_TITLES, type PanelId } from '../lib/panels.ts';

/**
 * Whether this panel is in the second window, and how to send it there or
 * fetch it back. A panel that cannot move — or an app with no second window
 * open — simply leaves it off.
 */
export interface PanelDetach {
  detached: boolean;
  onToggle: () => void;
}

/**
 * What this slot is showing, and the three things that can be done to the slot
 * itself: point it at another panel, open a second copy of it, or close it.
 *
 * All three name the *slot*, never the panel. The same panel may be open in
 * several slots at once, and the whole point of that is that the copies are
 * indistinguishable — so an operation that named the panel could not say which
 * of them it meant.
 */
export interface PanelChoice {
  id: PanelId;
  onChange: (next: PanelId) => void;
  onDuplicate: () => void;
  onClose: () => void;
}

export function Panel({
  title,
  actions,
  detach,
  choice,
  children,
  flush = false,
}: {
  title: string;
  actions?: ReactNode;
  detach?: PanelDetach;
  choice?: PanelChoice;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        {/* Still an `h2` with the chooser inside it rather than a bare select:
          `select` is phrasing content, so this is the same document outline it
          always was, and the heading's accessible name is the panel on screen. */}
        <h2 className="panel-title">{choice ? <PanelChooser choice={choice} /> : title}</h2>
        {actions || detach || choice ? (
          <div className="panel-actions">
            {actions}
            {detach ? <DetachButton title={title} detach={detach} /> : null}
            {choice ? <SlotButtons title={title} choice={choice} /> : null}
          </div>
        ) : null}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

/**
 * Turns this slot over to a different panel.
 *
 * A native `select`, not a menu of our own: it is keyboard-navigable and
 * type-ahead searchable for free, and the platform draws it where the platform
 * puts menus — which matters here, because a panel dragged small has no room
 * to hang one of our own inside it.
 */
function PanelChooser({ choice }: { choice: PanelChoice }) {
  return (
    <select
      className="panel-chooser"
      value={choice.id}
      aria-label="What this panel shows"
      title="Show a different panel here"
      onChange={(event) => choice.onChange(event.target.value as PanelId)}
    >
      {PANELS.map((id) => (
        <option key={id} value={id}>
          {PANEL_TITLES[id]}
        </option>
      ))}
    </select>
  );
}

/**
 * Open a second copy of this panel, or close this one.
 *
 * The close button is the Mac's: a red disc that shows its × on hover, which is
 * where the gesture is already learned. It is the last control in the header
 * rather than the first, because that is where the web puts a close and because
 * the header's controls wrap — a close pinned to the left would be the one
 * thing that never moves while everything around it does.
 */
function SlotButtons({ title, choice }: { title: string; choice: PanelChoice }) {
  return (
    <>
      <button
        className="panel-duplicate"
        onClick={choice.onDuplicate}
        aria-label={`Open a second ${title} panel`}
        title={`Open a second ${title} panel below this one. Both show the same thing.`}
      >
        +
      </button>
      <button
        className="panel-close"
        onClick={choice.onClose}
        aria-label={`Close the ${title} panel`}
        title={`Close the ${title} panel`}
      >
        <span aria-hidden="true">×</span>
      </button>
    </>
  );
}

/**
 * Sends the panel to the second window, or brings it back.
 *
 * Both labels are one glyph wide, so the header does not shift when it is
 * pressed — the same reason the full-screen and plane buttons hold their width.
 * The arrows point the way the panel is about to go.
 */
function DetachButton({ title, detach }: { title: string; detach: PanelDetach }) {
  const label = detach.detached
    ? `Bring ${title} back to this window`
    : `Show ${title} in the second window`;
  return (
    <button
      className="panel-detach"
      onClick={detach.onToggle}
      aria-pressed={detach.detached}
      aria-label={label}
      title={label}
    >
      {detach.detached ? '↙' : '↗'}
    </button>
  );
}

/**
 * What is left in place of a panel that has moved to the second window.
 *
 * A gap would be tidier and worse: the second window may be behind this one or
 * on a display the user is not looking at, so a panel that simply vanished
 * would read as a panel that broke. This says where it went and offers it back.
 */
export function PanelStub({ title, onReturn }: { title: string; onReturn: () => void }) {
  return (
    <section className="panel panel-stub">
      <h2 className="panel-title">{title}</h2>
      <span className="hint">in the second window</span>
      <button className="subtle" onClick={onReturn}>
        bring back
      </button>
    </section>
  );
}

/** Renders an engine refusal as a message instead of letting it blank the app. */
export function ErrorNote({ message }: { message: string }) {
  return <p className="error">{message}</p>;
}
