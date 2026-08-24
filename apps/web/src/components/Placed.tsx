import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelStub } from './Panel.tsx';

/**
 * The panels that can be moved to the second window, in the order they are
 * stacked once they get there — the order they appear in on one screen, so
 * splitting the app across two does not reshuffle it.
 */
export const PANELS = ['source', 'system', 'firstOrder', 'layout', 'analysis'] as const;

export type PanelId = (typeof PANELS)[number];

/** Titles for the stubs left behind, which have no panel to read one from. */
export const PANEL_TITLES: Record<PanelId, string> = {
  source: 'Source object',
  system: 'Optical system',
  firstOrder: 'First order',
  layout: 'Layout',
  analysis: 'Analysis',
};

export interface Placement {
  /** Which panels are in the second window. */
  detached: Partial<Record<PanelId, boolean>>;
  /** Where to render them, or undefined while there is no second window. */
  container: HTMLElement | undefined;
  onReturn: (id: PanelId) => void;
}

/**
 * Renders a panel where it belongs: in place, or in the second window.
 *
 * A portal and not a second React root, so a detached panel stays in this tree
 * and goes on reading the same `system`, the same traces, and the same view
 * settings as everything else. Nothing is copied between the windows because
 * there is only ever one of everything.
 */
export function Placed({
  id,
  placement,
  children,
}: {
  id: PanelId;
  placement: Placement;
  children: ReactNode;
}): ReactNode {
  const { container, onReturn } = placement;
  if (placement.detached[id] !== true || container === undefined) {
    return children;
  }

  return (
    <>
      <PanelStub title={PANEL_TITLES[id]} onReturn={() => onReturn(id)} />
      {createPortal(
        // Portals sharing a container append in the order they mount rather than
        // the order they are written, so a panel sent across second would land
        // under one sent first however this file is arranged. The slot carries
        // its own place in the list and the flex order settles it.
        <div className="secondary-slot" style={{ order: PANELS.indexOf(id) }}>
          {children}
        </div>,
        container,
      )}
    </>
  );
}
