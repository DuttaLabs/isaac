/**
 * An on-screen frame meter, for watching what a change costs.
 *
 * **Development only**, like everything else in `src/dev/`: it is reached only
 * from `TweakPanel`, which `App` imports behind `import.meta.env.DEV`, so a
 * production build drops the branch and `stats.js` with it. It is a
 * devDependency for the same reason `lil-gui` is.
 *
 * Two readouts rather than one, because they answer different questions. **FPS**
 * is capped at the display's refresh rate, so it says "smooth or not" and stops
 * being informative the moment it reads 60. **MS** is the frame interval, which
 * keeps moving above and below that line — it is the number that shows a change
 * making things 30% worse while the frame rate still says 60, and the number a
 * measurement in a commit message should quote.
 *
 * Click either panel to cycle it; stats.js also carries a memory readout, which
 * is why the click is left alone rather than suppressed.
 *
 * **It is off by default and it costs nothing while off.** An FPS meter can only
 * work by running a `requestAnimationFrame` loop, and that loop keeps the page
 * painting continuously whether or not anything has changed — which is exactly
 * the sort of thing that gets blamed later for the lag it was opened to measure.
 * So the loop is started by switching the meter on and cancelled by switching it
 * off, and there is nothing running in between.
 */

import { useEffect, useRef } from 'react';
import Stats from 'stats.js';

/** The panel each readout shows: 0 frames per second, 1 milliseconds, 2 memory. */
const FPS_PANEL = 0;
const MS_PANEL = 1;

export function StatsMeter({ showing }: { showing: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = host.current;
    if (!showing || container === null) {
      return;
    }

    const readouts = [FPS_PANEL, MS_PANEL].map((panel) => {
      const stats = new Stats();
      stats.showPanel(panel);
      // stats.js pins itself to the top-left corner of the window. Let the
      // container place them instead, so the two stack and sit where they are
      // out of the way of the app bar and the tweak panel.
      stats.dom.style.position = 'static';
      container.append(stats.dom);
      return stats;
    });

    // `update()` measures the interval between consecutive calls, so driving it
    // from the frame loop is what makes MS the *frame* time rather than the time
    // spent inside any one piece of work.
    let frame = requestAnimationFrame(function tick() {
      for (const stats of readouts) {
        stats.update();
      }
      frame = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frame);
      for (const stats of readouts) {
        stats.dom.remove();
      }
    };
  }, [showing]);

  // Mounted while hidden so the effect above has somewhere to attach the moment
  // it is switched on, and so switching it off leaves nothing behind.
  return <div className="dev-stats" ref={host} hidden={!showing} />;
}
