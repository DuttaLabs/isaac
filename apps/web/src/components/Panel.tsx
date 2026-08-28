import type { ReactNode } from 'react';
import { PANELS, PANEL_TITLES, type PanelId } from '../lib/panels.ts';
import type { SplitDirection } from '../lib/workspace.ts';

/** What a blank pane is called, in the places that need a name for one. */
export const BLANK_PANE_TITLE = 'Empty';

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
 * What this pane is showing, and the three things that can be done to the pane
 * itself: point it at another panel, split it in two, or close it.
 *
 * All three name the *pane*, never the panel. The same panel may be open in
 * several panes at once, and the whole point of that is that the copies are
 * indistinguishable — so an operation that named the panel could not say which
 * of them it meant.
 */
export interface PanelChoice {
  /** `undefined` on a blank pane, which is one waiting to be told what to show. */
  id: PanelId | undefined;
  onChange: (next: PanelId) => void;
  onSplit: (direction: SplitDirection) => void;
  onClose: () => void;
  /** Off on the last pane of an empty workspace: closing it would do nothing. */
  canClose?: boolean;
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
            {choice ? <PaneButtons title={title} choice={choice} /> : null}
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
      value={choice.id ?? ''}
      aria-label="What this panel shows"
      title="Show a different panel here"
      onChange={(event) => choice.onChange(event.target.value as PanelId)}
    >
      {/* A blank pane has nothing selected, so it needs somewhere for the
          selection to sit until the user makes one. */}
      {choice.id === undefined ? (
        <option value="" disabled>
          Choose a panel…
        </option>
      ) : null}
      {PANELS.map((id) => (
        <option key={id} value={id}>
          {PANEL_TITLES[id]}
        </option>
      ))}
    </select>
  );
}

/**
 * Split this pane in two, or close it.
 *
 * The splits are named for where the new pane lands — right, or below — rather
 * than for the cut, because "a horizontal split" means opposite things to
 * different people and the direction the divider *runs* is the opposite of the
 * direction it moves in. The panel that was here stays where it was; the new
 * half opens blank, waiting to be told what to show.
 *
 * The close button is the Mac's: a red disc that shows its × on hover, which is
 * where the gesture is already learned. It is the last control in the header
 * rather than the first, because that is where the web puts a close and because
 * the header's controls wrap — a close pinned to the left would be the one
 * thing that never moves while everything around it does.
 */
function PaneButtons({ title, choice }: { title: string; choice: PanelChoice }) {
  return (
    <>
      <button
        className="panel-split"
        onClick={() => choice.onSplit('row')}
        aria-label={`Split the ${title} panel, opening a new one to the right`}
        title="Split right — a new empty panel beside this one"
      >
        {/* A rectangle divided by an upright rule: the picture of what happens,
            which needs no word for the axis and so cannot be read backwards. */}
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
          <line x1="8" y1="3.5" x2="8" y2="12.5" />
        </svg>
      </button>
      <button
        className="panel-split"
        onClick={() => choice.onSplit('column')}
        aria-label={`Split the ${title} panel, opening a new one below`}
        title="Split down — a new empty panel below this one"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
          <line x1="1.5" y1="8" x2="14.5" y2="8" />
        </svg>
      </button>
      {choice.canClose === false ? null : (
        <button
          className="panel-close"
          onClick={choice.onClose}
          aria-label={`Close the ${title} panel`}
          title={`Close the ${title} panel`}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </>
  );
}

/**
 * A pane with nothing in it yet — the far half of a fresh split.
 *
 * The header's chooser would do on its own; this offers the same list as
 * buttons because a new pane is opened *in order to* put something in it, and
 * one click is the whole of that. It looks like a panel rather than like a hole,
 * so a split reads as two panels from the moment it happens.
 */
export function BlankPanel({ choice, detach }: { choice: PanelChoice; detach?: PanelDetach }) {
  return (
    <Panel title={BLANK_PANE_TITLE} choice={choice} detach={detach}>
      <div className="blank-pane">
        <p className="hint">Choose what to show here.</p>
        <div className="blank-pane-choices">
          {PANELS.map((id) => (
            <button key={id} className="subtle" onClick={() => choice.onChange(id)}>
              {PANEL_TITLES[id]}
            </button>
          ))}
        </div>
      </div>
    </Panel>
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
