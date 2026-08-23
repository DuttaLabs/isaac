import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import {
  buildLayout,
  pupilAim,
  rayPath,
  toPath,
  type GlassBody,
  type LayoutPoint,
} from '../lib/layout.ts';
import type { FirstOrderRays, LayoutTrace } from '../lib/analysis.ts';
import type { RayTraceResult } from '@isaac/optical-core';
import { wavelengthStyle } from '../lib/wavelengths.ts';

const WIDTH = 900;
const HEIGHT = 340;
const PADDING = 18;

/** How far in and out the wheel may take the view, against the fitted layout. */
const MAX_ZOOM_IN = 200;
const MAX_ZOOM_OUT = 8;
/** Wheel delta to scale factor. Small enough that a trackpad flick is not a leap. */
const WHEEL_SENSITIVITY = 0.0015;

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FITTED: ViewBox = { x: 0, y: 0, width: WIDTH, height: HEIGHT };

/** Says which element is impossible and by how much, on hover. */
function crossedMessage(body: GlassBody, units: string): string {
  return (
    `Surfaces ${body.frontIndex} and ${body.backIndex} cross: the rear surface passes ` +
    `${Math.abs(body.leastGap).toPrecision(3)} ${units} in front of the front one. ` +
    'Reduce the semi-diameter, or increase the thickness or the radii.'
  );
}

/**
 * Meridional cross-section: the y–z plane a lens designer reads. Scaling is
 * uniform in both axes, so shapes are true rather than stretched to fill.
 */
export function LayoutView({
  system,
  traces,
  defaultSemiDiameter,
  highlightedSurface,
  resetSignal,
  firstOrder,
}: {
  system: OpticalSystem;
  traces: readonly LayoutTrace[];
  defaultSemiDiameter: number;
  /** Surface the user is on in the lens table, picked out so the row and the
   *  picture can be read together. */
  highlightedSurface?: number;
  /** Changes when the user asks for the view back, and at nothing else. */
  resetSignal: number;
  /** The first-order construction to draw over the design, when it is asked for. */
  firstOrder?: FirstOrderOverlay;
}) {
  const geometry = useMemo(
    () => buildLayout(system, traces, defaultSemiDiameter),
    [system, traces, defaultSemiDiameter],
  );

  const { view, svg, panning } = usePanZoom(resetSignal);

  const multipleWavelengths = new Set(traces.map((trace) => trace.wavelengthIndex)).size > 1;

  const { minZ, maxZ, minY, maxY } = geometry.bounds;
  const spanZ = Math.max(maxZ - minZ, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((WIDTH - 2 * PADDING) / spanZ, (HEIGHT - 2 * PADDING) / spanY);

  const centerY = (minY + maxY) / 2;
  const project = (point: LayoutPoint): { x: number; y: number } => ({
    x: PADDING + (point.z - minZ) * scale,
    y: HEIGHT / 2 - (point.y - centerY) * scale,
  });

  const axisY = project({ z: 0, y: 0 }).y;

  return (
    <svg
      ref={svg}
      className={panning ? 'layout panning' : 'layout'}
      viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      role="img"
      aria-label={`Layout of ${system.name}, ${system.surfaces.length} surfaces`}
    >
      <line
        className="axis-line"
        x1={PADDING}
        y1={axisY}
        x2={WIDTH - PADDING}
        y2={axisY}
        strokeDasharray="4 4"
      />

      {geometry.bodies.map((body, index) => (
        <path
          key={`body-${index}`}
          d={toPath(body.points, project, true)}
          fill={body.crossed ? 'var(--glass-fill-crossed)' : 'var(--glass-fill)'}
          stroke="none"
        >
          {body.crossed ? <title>{crossedMessage(body, system.units)}</title> : null}
        </path>
      ))}

      {geometry.rayPaths.map((path, index) => {
        const style = wavelengthStyle(
          system.wavelengthsNm[path.wavelengthIndex] ?? 550,
          path.wavelengthIndex,
        );
        // Rays are drawn solid when only one wavelength is on screen: with
        // nothing to tell apart, a dash pattern just reads as a broken ray.
        const dash = multipleWavelengths ? style.dash : undefined;
        return (
          <path
            key={`ray-${index}`}
            d={toPath(path.points, project)}
            fill="none"
            stroke={style.color}
            strokeWidth={1}
            strokeDasharray={dash}
            opacity={path.blocked ? 0.25 : 0.85}
          />
        );
      })}

      {/*
        The ground edges close each element top and bottom. They are drawn with
        the profiles rather than with the fill so they sit above the rays, like
        the surfaces they join. A crossed element gets none: there is no edge to
        draw when the surfaces have passed through each other, and its absence
        is a second cue beside the color, which nobody should have to rely on
        alone.
      */}
      {geometry.bodies.flatMap((body, index) =>
        body.crossed
          ? []
          : [body.topEdge, body.bottomEdge].map((edge, side) => (
              <path
                key={`edge-${index}-${side}`}
                d={toPath(edge, project)}
                fill="none"
                stroke="var(--glass-stroke)"
                strokeWidth={1.5}
              />
            )),
      )}

      {geometry.profiles.map((profile) => {
        // Drawn heavier as well as colored: the highlight has to survive being
        // one thin line among many, and weight carries where a hue may not. A
        // mirror is set apart the same way — a cooler stroke and more of it —
        // because it is the one surface nothing passes through, and reading it
        // as a lens face makes the whole ray path look wrong.
        const highlighted = profile.surfaceIndex === highlightedSurface;
        const stroke = highlighted
          ? 'var(--surface-highlight)'
          : profile.isMirror
            ? 'var(--mirror)'
            : 'var(--glass-stroke)';
        return (
          <path
            key={`surface-${profile.surfaceIndex}`}
            d={toPath(profile.points, project)}
            fill="none"
            stroke={stroke}
            strokeWidth={highlighted ? 3 : profile.isMirror ? 2.5 : profile.isImage ? 2 : 1.5}
          >
            {profile.isMirror ? <title>{`Surface ${profile.surfaceIndex}: mirror`}</title> : null}
          </path>
        );
      })}

      {/*
        The first-order construction, drawn last so it sits over the design it
        describes. Two rays and two planes: everything first-order optics has to
        say about a system is in where these four things are.
      */}
      {firstOrder ? (
        <FirstOrderOverlayLayer overlay={firstOrder} project={project} zoom={view.width / WIDTH} />
      ) : null}

      {/* Stop markers: short bars just outside the clear aperture. */}
      {geometry.profiles
        .filter((profile) => profile.isStop)
        .map((profile) => {
          const top = profile.points[profile.points.length - 1]!;
          const bottom = profile.points[0]!;
          return [top, bottom].map((point, side) => {
            const projected = project(point);
            const direction = side === 0 ? -1 : 1;
            return (
              <line
                key={`stop-${profile.surfaceIndex}-${side}`}
                x1={projected.x}
                y1={projected.y}
                x2={projected.x}
                y2={projected.y + direction * 10}
                stroke="var(--stop-mark)"
                strokeWidth={2.5}
              />
            );
          });
        })}
    </svg>
  );
}

/**
 * Wheel to zoom, left button to drag the view about.
 *
 * The picture is moved by rewriting the SVG `viewBox` rather than by
 * transforming a group: the drawing keeps its own coordinates, stroke widths
 * scale with the zoom the way a drawing should, and the reset is a single
 * assignment back to the fitted box.
 */
function usePanZoom(resetSignal: number): {
  view: ViewBox;
  svg: React.RefObject<SVGSVGElement | null>;
  panning: boolean;
} {
  const [view, setView] = useState<ViewBox>(FITTED);
  const [panning, setPanning] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    from: ViewBox;
  } | null>(null);

  // Reset only on request. An edit elsewhere re-fits the drawing inside the
  // same box, so a zoomed-in user keeps looking at what they were looking at.
  useEffect(() => setView(FITTED), [resetSignal]);

  const zoom = useCallback((event: WheelEvent, element: SVGSVGElement): void => {
    // Without this the page scrolls behind the drawing.
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    // Where the pointer is, as a fraction of the box: that point stays put.
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;

    setView((current) => {
      const factor = Math.exp(event.deltaY * WHEEL_SENSITIVITY);
      const width = Math.min(
        Math.max(current.width * factor, WIDTH / MAX_ZOOM_IN),
        WIDTH * MAX_ZOOM_OUT,
      );
      // Height follows width so the scale stays uniform and shapes stay true.
      const height = width * (HEIGHT / WIDTH);
      return {
        x: current.x + (current.width - width) * fx,
        y: current.y + (current.height - height) * fy,
        width,
        height,
      };
    });
  }, []);

  // Registered by hand because a React `onWheel` is passive, and a passive
  // listener may not call preventDefault.
  useEffect(() => {
    const element = svg.current;
    if (element === null) {
      return;
    }
    const onWheel = (event: WheelEvent): void => zoom(event, element);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom]);

  useEffect(() => {
    const element = svg.current;
    if (element === null) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      element.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        from: view,
      };
      setPanning(true);
    };

    const onPointerMove = (event: PointerEvent): void => {
      const held = drag.current;
      if (held === null || held.pointerId !== event.pointerId) {
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      // Screen pixels into view-box units, so the drawing tracks the pointer
      // exactly however far the view is zoomed in.
      const dx = ((event.clientX - held.clientX) / rect.width) * held.from.width;
      const dy = ((event.clientY - held.clientY) / rect.height) * held.from.height;
      setView({ ...held.from, x: held.from.x - dx, y: held.from.y - dy });
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (drag.current?.pointerId !== event.pointerId) {
        return;
      }
      element.releasePointerCapture(event.pointerId);
      drag.current = null;
      setPanning(false);
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
    };
    // `view` is read when a drag starts, so the listeners are re-made when it
    // changes; that is what makes successive drags compose.
  }, [view]);

  return { view, svg, panning };
}

/** Everything the first-order overlay draws, gathered by the panel that owns it. */
export interface FirstOrderOverlay {
  rays: FirstOrderRays | undefined;
  entrance: PupilMark | undefined;
  exit: PupilMark | undefined;
}

/**
 * A pupil plane as it is drawn: where it is, and how wide the beam is there.
 *
 * The radius is the beam's, not the stop image's, and the two are not always the
 * same number. `entrancePupil()` images the stop, so it reports how big the stop
 * *is*; the system's aperture says how much of it the light is allowed to use.
 * When a design declares a 20 mm entrance pupil on a stop that is 30 mm across,
 * the light fills 20. Drawing 30 would put the marginal ray in the middle of its
 * own pupil, which is exactly the thing the overlay is trying to make obvious.
 */
export interface PupilMark {
  z: number;
  radius: number;
}

/**
 * The marginal ray, the chief ray, and the two pupil planes.
 *
 * Drawn as construction lines rather than as light: heavier than the ray bundle,
 * in colors deliberately outside the F/d/C wavelength palette, and each with its
 * own dash pattern so the four are told apart without relying on hue. The legend
 * under the layout repeats every one of those cues.
 *
 * Nothing here changes the view's bounds. Ticking a checkbox should not rescale
 * the drawing, and a pupil can be virtual and a long way outside the glass — the
 * First Order panel gives its position as a number for exactly that case.
 */
function FirstOrderOverlayLayer({
  overlay,
  project,
  zoom,
}: {
  overlay: FirstOrderOverlay;
  project: (point: LayoutPoint) => { x: number; y: number };
  /** Current viewBox scale, so labels keep one size on screen at any zoom. */
  zoom: number;
}) {
  const { rays, entrance, exit } = overlay;
  return (
    <g className="first-order">
      {entrance ? (
        <PupilPlane mark={entrance} kind="entrance" project={project} zoom={zoom} />
      ) : null}
      {exit ? <PupilPlane mark={exit} kind="exit" project={project} zoom={zoom} /> : null}

      {rays && entrance ? (
        <PupilAim result={rays.marginal} pupilZ={entrance.z} project={project} zoom={zoom} />
      ) : null}

      {rays
        ? (
            [
              { key: 'marginal', result: rays.marginal, dash: undefined },
              { key: 'chief', result: rays.chief, dash: '7 4' },
            ] as const
          ).map(({ key, result, dash }) => (
            <path
              key={key}
              className={`first-order-ray ${key}`}
              d={toPath(rayPath(result), project)}
              fill="none"
              strokeDasharray={dash}
              // A construction ray that never reached the image is still worth
              // drawing — where it stopped is the answer to "why is this
              // vignetted" — but it must not be mistaken for one that got there.
              opacity={result.status === 'TERMINATED' ? 1 : 0.45}
            >
              <title>
                {key === 'marginal'
                  ? 'Marginal ray: from the axial object point through the rim of the pupil. It sets the F/# and where the image lies.'
                  : `Chief ray: from the ${rays.chiefField} field through the center of the pupil. It sets the image height.`}
              </title>
            </path>
          ))
        : null}
    </g>
  );
}

/**
 * A pupil plane: a bar spanning the pupil, with a tick turned out at each end so
 * it reads as a measurement of the beam rather than as one more surface.
 */
function PupilPlane({
  mark,
  kind,
  project,
  zoom,
}: {
  mark: PupilMark;
  kind: 'entrance' | 'exit';
  project: (point: LayoutPoint) => { x: number; y: number };
  zoom: number;
}) {
  const entrance = kind === 'entrance';
  const top = project({ z: mark.z, y: mark.radius });
  const bottom = project({ z: mark.z, y: -mark.radius });
  const tick = 6 * zoom;

  return (
    <g className={`pupil-plane ${kind}`}>
      <title>
        {entrance
          ? `Entrance pupil: the aperture stop as object space sees it, and the plane every ray is aimed at. Diameter ${(2 * mark.radius).toPrecision(4)}.`
          : `Exit pupil: the aperture stop as image space sees it. The cone converging on the image appears to come from here. Diameter ${(2 * mark.radius).toPrecision(4)}.`}
      </title>
      <line x1={top.x} y1={top.y} x2={bottom.x} y2={bottom.y} strokeDasharray="3 3" />
      {[top, bottom].map((end, index) => (
        <line
          key={index}
          x1={end.x - tick}
          y1={end.y}
          x2={end.x + tick}
          y2={end.y}
          strokeDasharray="none"
        />
      ))}
      {/* The two pupils are often within a millimetre of each other, so their
          labels are put at opposite ends of the bar rather than side by side,
          where they would overlap at any useful zoom. Font size is scaled
          against the viewBox so a label keeps one size on screen. */}
      <text
        x={(entrance ? top.x : bottom.x) + tick + 2 * zoom}
        y={entrance ? top.y - 4 * zoom : bottom.y + 11 * zoom}
        fontSize={11 * zoom}
      >
        {entrance ? 'EP' : 'XP'}
      </text>
    </g>
  );
}

/**
 * The marginal ray produced straight on to the entrance pupil, and a dot where
 * it gets there. The geometry is {@link pupilAim}; this only draws it.
 */
function PupilAim({
  result,
  pupilZ,
  project,
  zoom,
}: {
  result: RayTraceResult;
  pupilZ: number;
  project: (point: LayoutPoint) => { x: number; y: number };
  zoom: number;
}) {
  const aim = pupilAim(result, pupilZ);
  if (aim === undefined) {
    return null;
  }
  const dot = project(aim.atPupil);

  return (
    <g className="pupil-aim">
      <title>
        The marginal ray continued as it arrived, ignoring the refraction: it meets the entrance
        pupil at the rim. That is the aperture object space sees, and it is what sets the range of
        angles the system accepts.
      </title>
      {aim.produced ? (
        <path d={toPath([aim.contact, aim.atPupil], project)} fill="none" strokeDasharray="3 3" />
      ) : null}
      <circle cx={dot.x} cy={dot.y} r={2.5 * zoom} />
    </g>
  );
}
