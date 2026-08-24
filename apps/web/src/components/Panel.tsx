import type { ReactNode } from 'react';

/**
 * Whether this panel is in the second window, and how to send it there or
 * fetch it back. A panel that cannot move — or an app with no second window
 * open — simply leaves it off.
 */
export interface PanelDetach {
  detached: boolean;
  onToggle: () => void;
}

export function Panel({
  title,
  actions,
  detach,
  children,
  flush = false,
}: {
  title: string;
  actions?: ReactNode;
  detach?: PanelDetach;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {actions || detach ? (
          <div className="panel-actions">
            {actions}
            {detach ? <DetachButton title={title} detach={detach} /> : null}
          </div>
        ) : null}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

/**
 * Sends the panel to the second window, or brings it back.
 *
 * Both labels are one glyph wide, so the header does not shift when it is
 * pressed — the same reason the full-screen and 2D/3D buttons hold their width.
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
