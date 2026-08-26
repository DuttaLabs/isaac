import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelStub } from './Panel.tsx';
import { PANEL_TITLES, type PanelId } from '../lib/panels.ts';

export interface Placement {
  /** Which *slots* are in the second window, by slot key. */
  detached: Readonly<Record<string, boolean>>;
  /** Where to render them, or undefined while there is no second window. */
  container: HTMLElement | undefined;
  /**
   * The slot keys in the order their slots are arranged, which is the order
   * they stack once they are in the second window. Read from the live
   * arrangement rather than from a fixed list, so re-pointing or closing a slot
   * moves the panel in both windows and splitting the app across two never
   * reshuffles it.
   */
  order: readonly string[];
  onReturn: (slotKey: string) => void;
}

/**
 * Renders a panel where it belongs: in place, or in the second window.
 *
 * A portal and not a second React root, so a detached panel stays in this tree
 * and goes on reading the same `system`, the same traces, and the same view
 * settings as everything else. Nothing is copied between the windows because
 * there is only ever one of everything — which is also exactly why two copies
 * of a panel mirror each other for free, in one window or across both.
 *
 * Addressed by `slotKey`, not by panel: the same panel may be open several
 * times, and only the slot says which of them was sent across.
 */
export function Placed({
  slotKey,
  panel,
  placement,
  children,
}: {
  slotKey: string;
  panel: PanelId;
  placement: Placement;
  children: ReactNode;
}): ReactNode {
  const { container, onReturn } = placement;
  if (placement.detached[slotKey] !== true || container === undefined) {
    return children;
  }

  return (
    <>
      <PanelStub title={PANEL_TITLES[panel]} onReturn={() => onReturn(slotKey)} />
      {createPortal(
        // Portals sharing a container append in the order they mount rather than
        // the order they are written, so a panel sent across second would land
        // under one sent first however this file is arranged. The slot carries
        // its own place in the list and the flex order settles it.
        <div className="secondary-slot" style={{ order: placement.order.indexOf(slotKey) }}>
          {children}
        </div>,
        container,
      )}
    </>
  );
}
