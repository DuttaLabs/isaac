import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { adoptStyles, mirrorTheme, type SecondaryWindowHandle } from '../lib/secondary-window.ts';

/**
 * Renders its children into an already-open second window.
 *
 * The window is opened by the click that asked for it and handed in here rather
 * than opened in an effect, for two reasons that point the same way: a popup is
 * only permitted while the user's activation is live, and an effect under
 * StrictMode runs twice, which would open a window, close it, and open another.
 *
 * For the same reason this does not close the window when it unmounts —
 * StrictMode's second pass would then be portalling into a closed one. Closing
 * is the caller's to do, at the point the user asks for it.
 */
export function SecondaryWindow({
  handle,
  title,
  onClose,
  children,
}: {
  handle: SecondaryWindowHandle;
  /** Kept current, so loading a lens file does not leave the old name on the window. */
  title: string;
  /** Called when the window goes away on its own — the user closed it. */
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    handle.window.document.title = title;
  }, [handle, title]);

  useEffect(() => adoptStyles(handle.window.document), [handle]);
  useEffect(() => mirrorTheme(handle.window.document), [handle]);

  useEffect(() => {
    const opened = handle.window;

    // Closing the window fires `pagehide` on it, but one closed while the opener
    // is busy elsewhere can go without a word, so the flag is watched as well.
    // Either way the panels have to come home; nothing renders into a closed
    // window, and they would simply vanish.
    opened.addEventListener('pagehide', onClose);
    const poll = window.setInterval(() => {
      if (opened.closed) {
        onClose();
      }
    }, 500);

    // A popup outlives its opener, so without this a reload would leave one
    // behind on the other monitor with nothing rendering into it.
    const closeWithOpener = (): void => opened.close();
    window.addEventListener('pagehide', closeWithOpener);

    return () => {
      opened.removeEventListener('pagehide', onClose);
      window.clearInterval(poll);
      window.removeEventListener('pagehide', closeWithOpener);
    };
  }, [handle, onClose]);

  return createPortal(children, handle.container);
}
