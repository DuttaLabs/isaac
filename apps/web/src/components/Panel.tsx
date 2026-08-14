import type { ReactNode } from 'react';

export function Panel({
  title,
  actions,
  children,
  flush = false,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

/** Renders an engine refusal as a message instead of letting it blank the app. */
export function ErrorNote({ message }: { message: string }) {
  return <p className="error">{message}</p>;
}
