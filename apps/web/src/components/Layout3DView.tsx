import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber';
import { Box3, DoubleSide, MOUSE, Quaternion, Sphere, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { OpticalSystem } from '@isaac/optical-core';
import { buildOpticalScene, type OpticalScene } from '@isaac/three-optics';
import type { LayoutTrace } from '../lib/analysis.ts';
import { fieldStyle } from '../lib/fields.ts';
import { useThemeColors } from '../lib/theme-colors.ts';
import { AxisTriad } from './AxisTriad.tsx';
import { cameraAxes } from '../lib/camera-axes.ts';
import type { ProjectedAxis } from '../lib/view-plane.ts';

// Three's own controls rather than a wrapper library: the app needs one class
// from them, and the mouse mapping below is the whole of the configuration.
extend({ OrbitControls });

declare module '@react-three/fiber' {
  interface ThreeElements {
    orbitControls: ThreeElement<typeof OrbitControls>;
  }
}

/**
 * Where the camera sits before anyone touches it: mostly to one side of the
 * axis, a little above it, and a little toward the object. Looking *along* the
 * axis is the tempting default and the wrong one — an optical system is long and
 * thin, so end-on it recedes into the distance and near lenses bloat out of
 * scale. From the side the axis lies across the frame, as it does in the 2-D
 * view, and the third dimension shows in the height instead.
 *
 * The side matters: viewed from −X the screen's right-hand direction is +Z, so
 * light runs left to right exactly as it does in the 2-D layout and in every
 * optical drawing. From +X the whole system reads mirrored.
 */
const HOME_DIRECTION = new Vector3(-0.86, 0.42, -0.28).normalize();

/** Vertical field of view. Narrow: long systems foreshorten badly on a wide one. */
const FIELD_OF_VIEW = 24;

/** The canvas aspect, fixed in CSS so the panel does not jump when views swap. */
const ASPECT = 900 / 340;

/** Breathing room around the system once it is fitted. */
const FIT_MARGIN = 1.12;

/**
 * The mouse mapping: the wheel zooms, the left button pans, and the wheel
 * pressed and dragged orbits. Three's own default rotates with the left button;
 * this matches the 2-D view instead, where a left drag can only mean pan, so the
 * same gesture means the same thing in both views.
 */
const MOUSE_BUTTONS = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.ROTATE } as const;

/** The orientation gizmo's own little SVG, big enough to hold it and no more. */
const TRIAD_BOX = 84;

/**
 * How far the camera has to turn before the gizmo is redrawn, in radians —
 * about a fifteenth of a degree. Publishing every frame would re-render the
 * gizmo while the camera sits still as well as while it orbits, and below this
 * the arrows do not move by a whole pixel.
 */
const ORIENTATION_EPSILON = 0.0012;

/** The setter the gizmo hands the scene, so only the gizmo re-renders. */
type PublishAxes = RefObject<((axes: ProjectedAxis[]) => void) | undefined>;

/**
 * Reads the camera every frame and hands the gizmo its axes.
 *
 * It lives inside the canvas because that is the only place the camera exists,
 * and it publishes through a ref rather than up through props: a state setter
 * called on this component's parent would re-render the whole scene on every
 * frame of an orbit, and the thing that actually changed is nine SVG elements.
 */
function CameraOrientation({ publish }: { publish: PublishAxes }) {
  const camera = useThree((state) => state.camera);
  const last = useRef(new Quaternion());
  const published = useRef(false);

  useFrame(() => {
    const send = publish.current;
    // The gizmo mounts after this does, so nothing is recorded as sent until it
    // has actually gone somewhere — otherwise the first frame would be dropped
    // and the gizmo would stay empty until the user moved the camera.
    if (send === undefined) {
      return;
    }
    if (published.current && last.current.angleTo(camera.quaternion) < ORIENTATION_EPSILON) {
      return;
    }
    last.current.copy(camera.quaternion);
    published.current = true;
    send(cameraAxes(camera.quaternion));
  });

  return null;
}

/**
 * The gizmo itself, an SVG laid over the canvas rather than geometry inside it:
 * it is a legend, so it belongs in the same medium as the 2-D view's — and the
 * ⊗/⊙ convention for an axis pointing through the screen is a 2-D symbol that
 * would have to be faked in three dimensions.
 *
 * It takes no pointer events. The corner of the canvas is as good a place to
 * start an orbit as any other, and a small dead patch there would be a puzzle.
 */
function OrientationGizmo({ register }: { register: PublishAxes }) {
  const [axes, setAxes] = useState<ProjectedAxis[] | undefined>(undefined);

  useEffect(() => {
    register.current = setAxes;
    return () => {
      register.current = undefined;
    };
  }, [register]);

  if (axes === undefined) {
    return null;
  }
  return (
    <svg
      className="layout-3d-triad"
      width={TRIAD_BOX}
      height={TRIAD_BOX}
      viewBox={`0 0 ${TRIAD_BOX} ${TRIAD_BOX}`}
      aria-hidden="true"
    >
      <AxisTriad
        axes={axes}
        label="Orientation: the world axes as the camera sees them."
        x={TRIAD_BOX / 2}
        y={TRIAD_BOX / 2}
      />
    </svg>
  );
}

/**
 * The system as a solid, seen from wherever the user puts the camera.
 *
 * Geometry comes from `@isaac/three-optics`, which knows nothing about React;
 * this file is the mount and the controls. Colors are resolved from the same
 * theme tokens the SVG views use, so the two layouts cannot drift apart.
 */
/** What `document.defaultView` hands back: a window with its globals, `ResizeObserver` among them. */
type DomWindow = Window & typeof globalThis;

/** The pixel ratios the canvas is drawn at, clamped as R3F's own `[min, max]` would. */
const MIN_PIXEL_RATIO = 1;
const MAX_PIXEL_RATIO = 2;

/**
 * The window this element is in, which is not `window` once the Layout panel has
 * been sent to the second one.
 *
 * Resolved from the mounted element rather than passed in, so nothing above has
 * to know where the panel is being drawn. It is only knowable after the first
 * render, which is why the canvas waits for it: two of the things R3F needs are
 * properties of a *window*, and starting it against the wrong one and correcting
 * it afterwards would throw away a WebGL context for nothing.
 */
function useOwnWindow(element: RefObject<HTMLElement | null>): DomWindow | undefined {
  const [view, setView] = useState<DomWindow>();
  useEffect(() => {
    setView(element.current?.ownerDocument.defaultView ?? undefined);
  }, [element]);
  return view;
}

/**
 * The device pixel ratio of a window, kept current as that window moves between
 * displays.
 *
 * R3F's `dpr={[min, max]}` clamps the *global* `devicePixelRatio`, so a panel in
 * the second window would be drawn at the first monitor's pixel density — and a
 * Retina laptop driving an ordinary external display would render the scene at
 * twice the resolution it needs. There is no event for a change of ratio, but a
 * `(resolution: Ndppx)` query stops matching the moment the ratio leaves N, so
 * each change is caught by asking again about the new value.
 */
function usePixelRatio(view: DomWindow | undefined): number {
  const [ratio, setRatio] = useState(() => window.devicePixelRatio);

  useEffect(() => {
    if (view === undefined) {
      return;
    }
    let query: MediaQueryList | undefined;
    const sync = (): void => {
      setRatio(view.devicePixelRatio);
      query?.removeEventListener('change', sync);
      query = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`);
      query.addEventListener('change', sync);
    };
    sync();
    return () => query?.removeEventListener('change', sync);
  }, [view]);

  return Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, ratio));
}

export function Layout3DView({
  system,
  traces,
  defaultSemiDiameter,
  highlightedSurface,
  resetSignal,
}: {
  system: OpticalSystem;
  traces: readonly LayoutTrace[];
  defaultSemiDiameter: number;
  /** Surface the user is on in the lens table, picked out as it is in 2-D. */
  highlightedSurface?: number;
  /** Changes when the user asks for the view back, and at nothing else. */
  resetSignal: number;
}) {
  const colors = useThemeColors();
  const mount = useRef<HTMLDivElement>(null);
  const view = useOwnWindow(mount);
  const pixelRatio = usePixelRatio(view);
  const publishAxes: PublishAxes = useRef(undefined);

  /**
   * R3F measures the canvas with a `ResizeObserver` taken from the global
   * `window`, and an observer belongs to the document of the realm that made it:
   * one built here never reports on an element in the second window, so the
   * canvas would sit at its untouched 300 × 150 default while its container was
   * a thousand pixels wide. `resize.polyfill` is the documented way to hand
   * `useMeasure` a different constructor, and in the main window this is the
   * very same one it would have used.
   */
  const resize = useMemo(() => (view ? { polyfill: view.ResizeObserver } : undefined), [view]);

  const scene = useMemo(
    () => buildOpticalScene(system, traces, { defaultSemiDiameter }),
    [system, traces, defaultSemiDiameter],
  );

  // Built outside the reconciler, so nothing disposes it for us.
  useEffect(() => () => scene.dispose(), [scene]);

  const framing = useMemo(() => frameFor(scene), [scene]);

  return (
    <div className="layout-3d" ref={mount}>
      {/* Held back one render until the window is known — see `useOwnWindow`. */}
      {view ? (
        <Canvas
          resize={resize}
          dpr={pixelRatio}
          camera={{
            fov: FIELD_OF_VIEW,
            near: framing.near,
            far: framing.far,
            position: framing.position,
          }}
          // A middle click starts autoscroll in some browsers, which fights the
          // orbit gesture; the canvas has no use for a context menu either.
          onPointerDown={(event) => {
            if (event.button === 1) {
              event.preventDefault();
            }
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <color attach="background" args={[colors.background]} />
          <ambientLight intensity={1.1} />
          <directionalLight position={[1, 1.4, -1]} intensity={1.6} />
          <directionalLight position={[-1, -0.6, 0.8]} intensity={0.5} />

          <Controls target={framing.target} home={framing.position} resetSignal={resetSignal} />
          <CameraOrientation publish={publishAxes} />

          <AxisLine from={framing.axisFrom} to={framing.axisTo} color={colors.axis} />

          {scene.elements.map((element) => (
            <mesh key={`element-${element.frontIndex}`} geometry={element.geometry}>
              <meshStandardMaterial
                color={element.crossed ? colors.faulty : colors.glass}
                transparent
                opacity={element.crossed ? 0.55 : 0.42}
                roughness={0.12}
                metalness={0}
                // A lens is looked through, so its far wall has to still be there
                // when the camera goes round behind it.
                side={DoubleSide}
                depthWrite={false}
              />
            </mesh>
          ))}

          {scene.surfaces.map((shell) => (
            <mesh key={`surface-${shell.surfaceIndex}`} geometry={shell.geometry}>
              {/* A mirror is shaded as what it is: opaque and metallic, so it
                reads as the end of the light path rather than as another pane
                the rays happen to cross. */}
              <meshStandardMaterial
                color={
                  shell.surfaceIndex === highlightedSurface
                    ? colors.highlight
                    : shell.isMirror
                      ? colors.mirror
                      : shell.isStop
                        ? colors.stop
                        : colors.surface
                }
                transparent={!shell.isMirror}
                opacity={shell.isMirror ? 1 : shell.isImage ? 0.5 : 0.66}
                roughness={shell.isMirror ? 0.25 : 0.55}
                // Held well below 1: there is no environment map in this scene, so
                // a fully metallic surface has nothing to reflect and renders
                // black. A quarter of the way is enough to read as polished while
                // the lights still pick out the curvature.
                metalness={shell.isMirror ? 0.25 : 0}
                side={DoubleSide}
              />
            </mesh>
          ))}

          {scene.rays.map((bundle, index) => {
            // Color by field, as the 2-D view does. There is no dash pattern in a
            // line material to carry the wavelength as well, so in three
            // dimensions the field is the only series shown — which is the one a
            // reader is separating in a spatial picture anyway.
            const style = fieldStyle(system.fields[bundle.fieldIndex], bundle.fieldIndex);
            return (
              <lineSegments key={`rays-${index}`} geometry={bundle.geometry}>
                <lineBasicMaterial
                  color={colors.fields[style.colorVariable] ?? colors.surface}
                  transparent
                  opacity={bundle.blocked ? 0.16 : 0.7}
                />
              </lineSegments>
            );
          })}
        </Canvas>
      ) : null}
      <OrientationGizmo register={publishAxes} />
    </div>
  );
}

/** The optical axis, so the system has something to sit on. */
function AxisLine({ from, to, color }: { from: number; to: number; color: string }) {
  const positions = useMemo(() => new Float32Array([0, 0, from, 0, 0, to]), [from, to]);

  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0.55} />
    </lineSegments>
  );
}

/**
 * Orbit controls, and the reset. They live inside the canvas because they need
 * the camera and the canvas element, and neither exists outside it.
 */
function Controls({
  target,
  home,
  resetSignal,
}: {
  target: [number, number, number];
  home: [number, number, number];
  resetSignal: number;
}) {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const controls = useRef<OrbitControls>(null);

  // A new system reframes the scene, and the reset button restores that framing
  // — one effect, because they are the same operation asked for two ways.
  useEffect(() => {
    camera.position.set(...home);
    const orbit = controls.current;
    if (orbit) {
      orbit.target.set(...target);
      orbit.update();
    }
  }, [camera, home, target, resetSignal]);

  // Damping only settles if the controls are stepped every frame.
  useFrame(() => controls.current?.update());

  return (
    <orbitControls
      ref={controls}
      args={[camera, domElement]}
      mouseButtons={MOUSE_BUTTONS}
      enableDamping
      dampingFactor={0.12}
      zoomToCursor
    />
  );
}

interface Framing {
  position: [number, number, number];
  target: [number, number, number];
  near: number;
  far: number;
  axisFrom: number;
  axisTo: number;
}

/**
 * Puts the camera where the whole system is in view, three-quarters on rather
 * than square to it: the point of a 3-D view is that it is not the 2-D one, and
 * looking straight down the x axis would reproduce it exactly.
 */
function frameFor(scene: OpticalScene): Framing {
  const box = new Box3(new Vector3(...scene.bounds.min), new Vector3(...scene.bounds.max));
  const sphere = box.getBoundingSphere(new Sphere());
  const radius = Math.max(sphere.radius, 1e-3);

  // Seen from the side, the system's length lies across the frame and its
  // diameter up it, so the two axes need different distances and the camera
  // takes whichever is further. Fitting the bounding sphere instead would pull
  // back far enough for the length in *both* directions and leave a long lens
  // stranded in the middle of an empty frame.
  const size = box.getSize(new Vector3());
  const halfHeight = Math.max(size.y, size.x) / 2;
  const halfLength = Math.max(size.z, 1e-6) / 2;

  const verticalTan = Math.tan((FIELD_OF_VIEW * Math.PI) / 360);
  const distance =
    Math.max(halfHeight / verticalTan, halfLength / (verticalTan * ASPECT)) * FIT_MARGIN;

  const position = sphere.center.clone().add(HOME_DIRECTION.clone().multiplyScalar(distance));

  return {
    position: [position.x, position.y, position.z],
    target: [sphere.center.x, sphere.center.y, sphere.center.z],
    near: Math.max(radius / 500, 1e-4),
    far: distance + radius * 20,
    axisFrom: scene.bounds.min[2],
    axisTo: scene.bounds.max[2],
  };
}
