import { useCallback, useEffect, useState } from 'react';

/**
 * Full-screen toggle for the whole page, so a wide design fills the display.
 *
 * Safari still ships this API under a `webkit` prefix, and the types do not know
 * about it, so each entry point is looked up on the document and narrowed here.
 */
interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function fullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function fullscreenSupported(): boolean {
  const root = document.documentElement as FullscreenElement;
  return typeof (root.requestFullscreen ?? root.webkitRequestFullscreen) === 'function';
}

/**
 * Tracks full-screen state from the *document*, not from a click, because the
 * browser can leave full screen without going through this button — Esc, F11,
 * and the window controls all do it. Deriving the label from our own state
 * instead would let it drift out of step with the window.
 */
function useFullscreen(): { active: boolean; supported: boolean; toggle: () => Promise<void> } {
  const [active, setActive] = useState(() => fullscreenElement() !== null);
  const [supported] = useState(fullscreenSupported);

  useEffect(() => {
    const sync = () => setActive(fullscreenElement() !== null);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const toggle = useCallback(async () => {
    if (fullscreenElement()) {
      const doc = document as FullscreenDocument;
      await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    } else {
      const root = document.documentElement as FullscreenElement;
      await (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.());
    }
  }, []);

  return { active, supported, toggle };
}

/**
 * The request can be refused — most often because the page is framed without
 * `allow="fullscreen"`, or because policy forbids it — so failure is reported
 * rather than leaving a button that silently does nothing.
 */
export function FullScreenButton({ onError }: { onError?: (message: string) => void }) {
  const { active, supported, toggle } = useFullscreen();

  return (
    <button
      onClick={() => {
        toggle().catch((error: unknown) => {
          onError?.(
            `Could not ${active ? 'leave' : 'enter'} full screen: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }}
      disabled={!supported}
      aria-pressed={active}
      title={
        !supported
          ? 'This browser does not offer full screen'
          : active
            ? 'Return to the normal window'
            : 'Show the design on the whole display'
      }
    >
      {/*
        Both labels sit in one grid cell, so the button is always as wide as the
        longer of the two and the toolbar does not shift when it is pressed.
        Measuring in pixels instead would go wrong with a different font.
      */}
      <span className="label-swap">
        <span className={active ? undefined : 'label-hidden'}>Exit full screen</span>
        <span className={active ? 'label-hidden' : undefined}>Full screen</span>
      </span>
    </button>
  );
}
