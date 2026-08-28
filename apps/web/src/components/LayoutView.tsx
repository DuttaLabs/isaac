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
import { fieldStyle } from '../lib/fields.ts';
import { VIEW_PLANES, viewPlaneAxes, type ViewPlane } from '../lib/view-plane.ts';
import { AxisTriad } from './AxisTriad.tsx';

const WIDTH = 900;
const HEIGHT = 340;
const PADDING = 18;

/** How far in and out the wheel may take the view, against the fitted layout. */
const MAX_ZOOM_IN = 200;
const MAX_ZOOM_OUT = 8;
/** Wheel delta to scale factor. Small enough that a trackpad flick is not a leap. */
const WHEEL_SENSITIVITY = 0.0015;

/** The orientation gizmo's origin, in from the top-right corner of the view. */
const TRIAD_INSET = 46;
/** Half-length of the crosshairs standing in for an axis seen end-on. */
const AXIS_CROSS = 14;

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
 * A 2-D cross-section of the system, in whichever plane is asked for. Scaling is
 * uniform in both axes, so shapes are true rather than stretched to fill.
 *
 * Nothing here knows which plane it is drawing. The geometry arrives already
 * projected, as points with a horizontal and a vertical coordinate, and the two
 * things that genuinely differ between the views — whether the optical axis lies
 * in the picture, and whether a surface has a section or only a rim — are read
 * off the plane rather than branched on by name.
 */
export function LayoutView({
  system,
  traces,
  plane,
  defaultSemiDiameter,
  highlightedSurface,
  elementColors,
  endColors,
  resetSignal,
  firstOrder,
}: {
  system: OpticalSystem;
  traces: readonly LayoutTrace[];
  /** Which plane to draw. Defaults to the meridional one a layout has always meant. */
  plane?: ViewPlane;
  defaultSemiDiameter: number;
  /** Surface the user is on in the lens table, picked out so the row and the
   *  picture can be read together. */
  highlightedSurface?: number;
  /**
   * A color per surface, for the elements the user has colored. Keyed by surface
   * rather than by element because a body is identified by its front surface,
   * and a cemented pair is two bodies inside one element — both have to find the
   * same answer or the doublet comes out in two colors.
   */
  elementColors?: ReadonlyMap<number, string>;
  /** Color for the object and image planes, keyed by surface index. */
  endColors?: ReadonlyMap<number, string>;
  /** Changes when the user asks for the view back, and at nothing else. */
  resetSignal: number;
  /** The first-order construction to draw over the design, when it is asked for. */
  firstOrder?: FirstOrderOverlay;
}) {
  const drawn = plane ?? VIEW_PLANES.YZ;
  const geometry = useMemo(
    () => buildLayout(system, traces, defaultSemiDiameter, drawn),
    [system, traces, defaultSemiDiameter, drawn],
  );

  const { view, svg, panning } = usePanZoom(resetSignal);

  const multipleWavelengths = new Set(traces.map((trace) => trace.wavelengthIndex)).size > 1;

  const { minH, maxH, minV, maxV } = geometry.bounds;
  const spanH = Math.max(maxH - minH, 1e-6);
  const spanV = Math.max(maxV - minV, 1e-6);
  const scale = Math.min((WIDTH - 2 * PADDING) / spanH, (HEIGHT - 2 * PADDING) / spanV);

  // Centered both ways. A cross-section fills the width and cannot tell the
  // difference, but the end-on view is as tall as it is wide, and anchoring it
  // to the left edge would leave it against the frame with the rest of the panel
  // empty.
  const centerH = (minH + maxH) / 2;
  const centerV = (minV + maxV) / 2;
  const project = (point: LayoutPoint): { x: number; y: number } => ({
    x: WIDTH / 2 + (point.h - centerH) * scale,
    y: HEIGHT / 2 - (point.v - centerV) * scale,
  });

  const origin = project({ h: 0, v: 0 });
  const zoom = view.width / WIDTH;

  return (
    <svg
      ref={svg}
      className={panning ? 'layout panning' : 'layout'}
      viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      role="img"
      aria-label={`Layout of ${system.name} in the ${drawn.label} plane, ${system.surfaces.length} surfaces`}
    >
      {drawn.axial ? (
        <line
          className="axis-line"
          x1={PADDING}
          y1={origin.y}
          x2={WIDTH - PADDING}
          y2={origin.y}
          strokeDasharray="4 4"
        />
      ) : (
        // Seen end-on the optical axis is a point, not a line. Crosshairs mark
        // where it comes through; drawing it as a line would put an axis in the
        // picture that is not lying in this plane at all.
        <g className="axis-line" strokeDasharray="4 4">
          <line x1={origin.x - AXIS_CROSS} y1={origin.y} x2={origin.x + AXIS_CROSS} y2={origin.y} />
          <line x1={origin.x} y1={origin.y - AXIS_CROSS} x2={origin.x} y2={origin.y + AXIS_CROSS} />
        </g>
      )}

      {geometry.bodies.map((body, index) => (
        <path
          key={`body-${index}`}
          d={toPath(body.points, project, true)}
          // A crossed element keeps the fault color whatever the user chose:
          // the fill is the only thing saying the solid cannot be made, and a
          // chosen color would quietly overrule the warning.
          fill={
            body.crossed
              ? 'var(--glass-fill-crossed)'
              : (elementColors?.get(body.frontIndex) ?? 'var(--glass-fill)')
          }
          fillOpacity={elementColors?.has(body.frontIndex) && !body.crossed ? 0.45 : undefined}
          stroke="none"
        >
          {body.crossed ? <title>{crossedMessage(body, system.units)}</title> : null}
        </path>
      ))}

      {geometry.rayPaths.map((path, index) => {
        // Color carries the field and the dash carries the wavelength. In a
        // spatial picture the bundles are the series: each leaves at its own
        // angle and lands at its own height, so that is what a reader is
        // separating. Wavelength keeps the cue it can spare.
        const field = fieldStyle(system.fields[path.fieldIndex], path.fieldIndex);
        const wavelength = wavelengthStyle(
          system.wavelengthsNm[path.wavelengthIndex] ?? 550,
          path.wavelengthIndex,
        );
        // Solid when only one wavelength is on screen: with nothing to tell
        // apart, a dash pattern just reads as a broken ray.
        const dash = multipleWavelengths ? wavelength.dash : undefined;
        return (
          <path
            key={`ray-${index}`}
            d={toPath(path.points, project)}
            fill="none"
            stroke={field.color}
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
        // The two ends carry a color of their own, chosen in the Element column.
        const stroke = highlighted
          ? 'var(--surface-highlight)'
          : (endColors?.get(profile.surfaceIndex) ??
            (profile.isMirror ? 'var(--mirror)' : 'var(--glass-stroke)'));
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
        <FirstOrderOverlayLayer overlay={firstOrder} project={project} zoom={zoom} />
      ) : null}

      {/* Stop markers: short bars just outside the clear aperture — or, end-on,
          the rim itself, because a closed outline has no two ends to hang a bar
          off and the stop *is* the rim there. */}
      {geometry.profiles
        .filter((profile) => profile.isStop)
        .map((profile) => {
          if (profile.closed) {
            return (
              <path
                key={`stop-${profile.surfaceIndex}`}
                d={toPath(profile.points, project, true)}
                fill="none"
                stroke="var(--stop-mark)"
                strokeWidth={2}
                strokeDasharray="6 4"
              />
            );
          }
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

      {/*
        The orientation gizmo, drawn over everything and pinned to the corner of
        whatever part of the drawing is on screen: the view is panned by moving
        the viewBox, so a fixed corner is one computed from it. Scaled by the
        zoom for the same reason the overlay's labels are — it is a legend, and a
        legend that grows when you zoom in has stopped being one.
      */}
      <AxisTriad
        axes={viewPlaneAxes(drawn)}
        label={`${drawn.label} plane. ${drawn.description}`}
        x={view.x + view.width - TRIAD_INSET * zoom}
        y={view.y + TRIAD_INSET * zoom}
        scale={zoom}
      />
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
  /** Where the focal length is measured from; absent for an afocal system. */
  principal: PrincipalPlanes | undefined;
}

/** The pair of unit-magnification planes, and how tall to draw them. */
export interface PrincipalPlanes {
  frontZ: number;
  rearZ: number;
  radius: number;
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
  const { rays, entrance, exit, principal } = overlay;
  return (
    <g className="first-order">
      {principal ? <PrincipalPlaneMarks planes={principal} project={project} zoom={zoom} /> : null}
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
  // Axial planes only: `h` is the axis and `v` a height off it, which is what
  // the overlay's caller guarantees by offering it in the meridional view alone.
  const top = project({ h: mark.z, v: mark.radius });
  const bottom = project({ h: mark.z, v: -mark.radius });
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

/**
 * The two principal planes, `P` and `P'`.
 *
 * Drawn in plain ink rather than a color of their own. Every other thing in this
 * overlay is somewhere light goes — a ray, or a plane light passes through — and
 * a principal plane is neither: it is pure bookkeeping, the place a thick lens
 * behaves as though all its bending happened at. Neutral says that, and it keeps
 * a fourth hue out of an overlay that already carries three.
 *
 * They are worth showing because they are where a focal length is measured
 * *from*, and on a real lens they are almost never where you would guess — often
 * inside the glass, sometimes outside it, and on a strongly asymmetric design
 * crossed over each other so that P' sits ahead of P.
 */
function PrincipalPlaneMarks({
  planes,
  project,
  zoom,
}: {
  planes: PrincipalPlanes;
  project: (point: LayoutPoint) => { x: number; y: number };
  zoom: number;
}) {
  return (
    <g className="principal-planes">
      {(
        [
          { key: 'front', z: planes.frontZ, label: 'P' },
          { key: 'rear', z: planes.rearZ, label: 'P′' },
        ] as const
      ).map(({ key, z, label }) => {
        if (!Number.isFinite(z)) {
          return null;
        }
        const top = project({ h: z, v: planes.radius });
        const bottom = project({ h: z, v: -planes.radius });
        return (
          <g key={key}>
            <title>
              {key === 'front'
                ? 'Front principal plane P: the front focal point lies one focal length before it.'
                : 'Rear principal plane P′: the rear focal point lies one focal length after it. To first order the whole lens behaves as a thin one placed here.'}
            </title>
            <line x1={top.x} y1={top.y} x2={bottom.x} y2={bottom.y} strokeDasharray="9 5" />
            <text x={top.x + 3 * zoom} y={top.y - 4 * zoom} fontSize={11 * zoom}>
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
