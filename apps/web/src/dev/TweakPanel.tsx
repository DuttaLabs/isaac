/**
 * The knobs themselves, in a `lil-gui` panel floating over the app.
 *
 * **Development only.** `App` reaches this module through a dynamic import
 * behind `import.meta.env.DEV`, so a production build drops the branch and
 * `lil-gui` with it — verified by building and grepping the bundle, not
 * assumed. It is a devDependency for the same reason.
 *
 * A library here where the rest of the app hand-rolls its controls, because
 * everything that argued against one argues about *product* UI: this panel does
 * not have to match Isaac's look, mirror across duplicate panels, or land on
 * the undo stack. It has to give a slider with a live number beside it, which
 * is one line of `lil-gui` and about thirty of ours.
 */

import { useEffect, useRef, useState } from 'react';
import GUI from 'lil-gui';
import { DEFAULT_TWEAKS, currentTweaks, formatTweaks, setTweaks, type Tweaks } from './tweaks.ts';
import { StatsMeter } from './StatsMeter.tsx';
import './tweaks.css';

/**
 * Values survive a reload, because finding the right transparency takes more
 * sittings than one and losing them to a hot reload is its own small tax.
 * Merged over the defaults rather than trusted whole: a blob saved before a
 * knob existed is missing that key, and `undefined` would reach a material.
 */
const STORAGE_KEY = 'isaac.dev.tweaks';

/**
 * Whether the frame meter is showing. Its own key, and deliberately **not** a
 * field of `Tweaks`: everything in that record is a value being settled on, to
 * be pasted into `DEFAULT_TWEAKS` when it is — and `formatTweaks` writes every
 * key it finds there. A display toggle emitted into that source would ship as a
 * frozen default, which is the one thing the tweak store is not for.
 *
 * Kept across reloads all the same, because watching a number over a few edits
 * is the whole point and re-opening the panel each time is a tax on doing it.
 */
const STATS_KEY = 'isaac.dev.showStats';

function restoreShowStats(): boolean {
  try {
    return localStorage.getItem(STATS_KEY) === 'true';
  } catch {
    return false;
  }
}

function restore(): Tweaks {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved === null || typeof saved !== 'object') {
      return DEFAULT_TWEAKS;
    }
    return { ...DEFAULT_TWEAKS, ...(saved as Partial<Tweaks>) };
  } catch {
    // Unparseable, or storage blocked. The defaults are always an answer.
    return DEFAULT_TWEAKS;
  }
}

function persist(values: Tweaks): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Private window, quota, blocked storage: not worth interrupting anyone for.
  }
}

/**
 * The clipboard needs a secure context, and the dev server is reachable on a
 * LAN address that is not one — which is exactly where a tablet reads it. So
 * the values go to the console too, and the console is the fallback when the
 * write is refused.
 */
function copyValues(values: Tweaks): void {
  const source = formatTweaks(values);
  console.log(source);
  void navigator.clipboard?.writeText(source).catch(() => {
    /* Already logged; the console copy is the answer. */
  });
}

export default function TweakPanel({ open }: { open: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [showStats, setShowStats] = useState(restoreShowStats);

  // Restored once, on the first mount, and pushed into the store whether or not
  // the panel is open: the point of saving them is that the picture looks the
  // way it was left, not that the panel remembers where its sliders were.
  useEffect(() => {
    setTweaks(restore());
  }, []);

  useEffect(() => {
    const container = host.current;
    if (!open || container === null) {
      return;
    }

    // lil-gui writes into a plain object, so this is the mutable copy it owns;
    // the store gets a fresh snapshot on every change.
    const params: Tweaks = { ...currentTweaks() };
    const gui = new GUI({ container, title: 'Tweaks (dev)', width: 300 });

    const appearance = gui.addFolder('3D appearance');
    appearance.add(params, 'elementOpacity', 0, 1, 0.01).name('Lens body');
    appearance.add(params, 'crossedElementOpacity', 0, 1, 0.01).name('Crossed body');
    appearance.add(params, 'surfaceOpacity', 0, 1, 0.01).name('Bare surface');
    appearance.add(params, 'imageSurfaceOpacity', 0, 1, 0.01).name('Image plane');
    appearance.add(params, 'rayOpacity', 0, 1, 0.01).name('Ray');
    appearance.add(params, 'blockedRayOpacity', 0, 1, 0.01).name('Blocked ray');
    appearance.add(params, 'axisOpacity', 0, 1, 0.01).name('Optical axis');

    const camera = gui.addFolder('3D camera');
    camera.add(params, 'projection', ['perspective', 'orthographic']).name('Projection');
    camera.add(params, 'fieldOfView', 4, 70, 0.5).name('Field of view °');
    camera.add(params, 'fitMargin', 1, 2, 0.01).name('Fit margin');
    camera.add(params, 'cameraDistance', 0.25, 4, 0.05).name('Distance (x fit)');

    const table = gui.addFolder('Lens table');
    table.add(params, 'apertureIconScale', 0, 1, 0.02).name('Aperture icon');

    // Outside `params`, because it is not one of the tweaked values and must not
    // reach `setTweaks` or the copied-out source. lil-gui writes into whatever
    // object it is handed, so this one is its own.
    const meter = { 'Frame meter': showStats };
    const speed = gui.addFolder('Performance');
    speed
      .add(meter, 'Frame meter')
      .name('Frame meter (FPS · ms)')
      .onChange((on: boolean) => {
        setShowStats(on);
        try {
          localStorage.setItem(STATS_KEY, String(on));
        } catch {
          // Blocked storage: the meter still works, it just forgets.
        }
      });

    gui.onChange(() => {
      const next = { ...params };
      setTweaks(next);
      persist(next);
    });

    const actions = {
      'Copy values': () => copyValues(currentTweaks()),
      'Reset to defaults': () => {
        Object.assign(params, DEFAULT_TWEAKS);
        setTweaks({ ...DEFAULT_TWEAKS });
        persist(DEFAULT_TWEAKS);
        gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
      },
    };
    gui.add(actions, 'Copy values');
    gui.add(actions, 'Reset to defaults');

    return () => {
      gui.destroy();
    };
    // Keyed on `open` alone. `showStats` is read when the GUI is built, and a
    // change to it must *not* rebuild the panel: the checkbox already holds the
    // value it was built with, and tearing the GUI down would collapse every
    // folder the moment the meter was switched on.
  }, [open]);

  // The host stays mounted while closed so the restore effect above keeps its
  // place in the tree; `hidden` costs nothing and the GUI itself is destroyed.
  return (
    <>
      <div className="dev-tweaks" ref={host} hidden={!open} />
      {/* Not gated on `open`: the meter is watched *while working*, which means
          with the panel that switched it on closed again. */}
      <StatsMeter showing={showStats} />
    </>
  );
}
