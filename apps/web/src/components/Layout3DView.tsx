import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Canvas, extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber';
import {
  Box3,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  MOUSE,
  Quaternion,
  Sphere,
  Vector3,
  type LineSegments,
  type OrthographicCamera,
  type PerspectiveCamera,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { OpticalSystem } from '@isaac/optical-core';
import { buildOpticalScene, type OpticalScene } from '@isaac/three-optics';
import type { LayoutTrace } from '../lib/analysis.ts';
import type { CameraState } from '../lib/panel-settings.ts';
import { fieldStyle } from '../lib/fields.ts';
import { useThemeColors } from '../lib/theme-colors.ts';
import { AxisTriad } from './AxisTriad.tsx';
import { cameraAxes } from '../lib/camera-axes.ts';
import type { ProjectedAxis } from '../lib/view-plane.ts';
import { useTweaks, type Tweaks } from '../dev/tweaks.ts';
import { placeCamera, type SystemExtent } from '../lib/camera-fit.ts';

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

/** The same direction as a plain tuple, which is what the fit takes. */
const HOME_TUPLE: readonly [number, number, number] = [
  HOME_DIRECTION.x,
  HOME_DIRECTION.y,
  HOME_DIRECTION.z,
];

/**
 * The camera is fitted against the canvas's *own* aspect, read from R3F inside
 * the canvas where it is known. It used to be fitted against a hard-coded
 * 900 / 340, which was the panel's shape back when `.layout-3d` carried a fixed
 * `aspect-ratio`; that CSS went when panels became freely resizable, and the
 * constant stayed behind, fitting every system to the shape of a panel that no
 * longer exists.
 *
 * Field of view and fit margin are `dev/tweaks.ts` knobs — see the note there on
 * why field of view only means anything together with the refit.
 */

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
  elementColors,
  hiddenSurfaces,
  surfaceColors,
  resetSignal,
  overlay,
  camera: savedCamera,
  onCamera,
}: {
  system: OpticalSystem;
  traces: readonly LayoutTrace[];
  defaultSemiDiameter: number;
  /** Surface the user is on in the lens table, picked out as it is in 2-D. */
  highlightedSurface?: number;
  /** A color per surface for colored elements, exactly as the 2-D view takes it. */
  elementColors?: ReadonlyMap<number, string>;
  /** Surfaces of elements switched out of the light. */
  hiddenSurfaces?: ReadonlySet<number>;
  /**
   * Color for whatever is drawn as a single surface rather than as a body: the
   * object and image planes, and a mirror the user has given a color to. Keyed
   * by surface index, exactly as the 2-D view takes it.
   */
  surfaceColors?: ReadonlyMap<number, string>;
  /** Changes when the user asks for the view back, and at nothing else. */
  resetSignal: number;
  /**
   * Controls drawn over the picture — the per-plot field filter. Taken as a
   * prop rather than wrapped around this component from outside, because a box
   * around `.layout-3d` is what puts the canvas back at 300 x 150.
   */
  overlay?: ReactNode;
  /** Where the camera was left, if it has been framed by hand. */
  camera?: CameraState;
  /** Reports a new one at the end of a gesture, and `undefined` on a reset. */
  onCamera?: (state: CameraState | undefined) => void;
}) {
  const colors = useThemeColors();
  const tweaks = useTweaks();
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
    () => buildOpticalScene(system, traces, { defaultSemiDiameter, hiddenSurfaces }),
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
          // R3F builds the default camera once, from these props. Switching
          // between the two kinds is therefore a remount, which is why the orbit
          // is stashed and restored either side of it.
          key={tweaks.projection}
          orthographic={tweaks.projection === 'orthographic'}
          resize={resize}
          dpr={pixelRatio}
          // Field of view only, and deliberately **no position**: R3F re-applies
          // this object to the camera on every render, so anything named here is
          // pinned and a fitted position would be stomped back on the next
          // re-render. Where the camera goes is `Controls`' business alone.
          camera={{ fov: tweaks.fieldOfView }}
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

          <Controls
            markColor={colors.axis}
            framing={framing}
            tweaks={tweaks}
            resetSignal={resetSignal}
            subject={system}
            saved={savedCamera}
            onCamera={onCamera}
          />
          <CameraOrientation publish={publishAxes} />

          <AxisLine
            from={framing.axisFrom}
            to={framing.axisTo}
            color={colors.axis}
            opacity={tweaks.axisOpacity}
          />

          {scene.elements.map((element) => (
            <mesh key={`element-${element.frontIndex}`} geometry={element.geometry}>
              <meshStandardMaterial
                // A crossed element keeps the fault color whatever the user
                // chose: it is the only thing saying the solid cannot be made.
                color={
                  element.crossed
                    ? colors.faulty
                    : (elementColors?.get(element.frontIndex) ?? colors.glass)
                }
                transparent
                opacity={element.crossed ? tweaks.crossedElementOpacity : tweaks.elementOpacity}
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
                    : // A color chosen in the Element column wins, which is what
                      // lets the two mirrors of a Cassegrain be told apart. Read
                      // before the mirror and stop defaults rather than after, or
                      // a mirror could never be given one. Safe to read for every
                      // shell: a glass body's faces are consumed into the body and
                      // never appear here, so nothing else can match.
                      (surfaceColors?.get(shell.surfaceIndex) ??
                      (shell.isMirror
                        ? colors.mirror
                        : shell.isStop
                          ? colors.stop
                          : colors.surface))
                }
                transparent={!shell.isMirror}
                opacity={
                  shell.isMirror
                    ? 1
                    : shell.isImage
                      ? tweaks.imageSurfaceOpacity
                      : tweaks.surfaceOpacity
                }
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

          {/* What an aperture *blocks*, drawn opaque and black.
              Black rather than a theme color, and deliberately: it is the one
              thing in the picture light does not get through, and every other
              material here is translucent or metallic. It is also the only mark
              that means the same in both themes without being given two
              values. */}
          {scene.obscurations.map((blocked) => (
            <mesh key={`obscuration-${blocked.surfaceIndex}`} geometry={blocked.geometry}>
              <meshStandardMaterial
                // Lit with its row, like the shells above. Black is what "light
                // does not get through" looks like and is why this one color is
                // written rather than taken from the theme — but a highlight is
                // a passing state, not a color the thing has. On a design that is
                // mostly baffles it is the only way to tell which row is which.
                color={blocked.surfaceIndex === highlightedSurface ? colors.highlight : '#000000'}
                roughness={0.9}
                metalness={0}
                side={DoubleSide}
                // An obscuration lies *exactly* on the surface it blocks — same
                // sag, same frame — so the depth buffer has no way to choose
                // between them and the two flicker against each other. The
                // offset biases this one toward the camera in depth alone,
                // which is what it is for: nothing moves, and the vane stops
                // fighting the mirror it is bolted to.
                polygonOffset
                polygonOffsetFactor={-1}
                polygonOffsetUnits={-1}
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
                  opacity={bundle.blocked ? tweaks.blockedRayOpacity : tweaks.rayOpacity}
                />
              </lineSegments>
            );
          })}
        </Canvas>
      ) : null}
      <OrientationGizmo register={publishAxes} />
      {/* Laid over the canvas in the container that already positions the
        gizmo, rather than in a wrapper of its own. A box put *around* this one
        breaks the flex chain the canvas takes its height from — `.layout-3d` is
        `flex: 1 1 0` precisely so R3F measures the panel rather than the
        canvas's untouched 300 x 150 default, and an intervening box sized by
        its content restores exactly that loop. */}
      {overlay}
    </div>
  );
}

/** The optical axis, so the system has something to sit on. */
function AxisLine({
  from,
  to,
  color,
  opacity,
}: {
  from: number;
  to: number;
  color: string;
  opacity: number;
}) {
  const positions = useMemo(() => new Float32Array([0, 0, from, 0, 0, to]), [from, to]);

  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </lineSegments>
  );
}

/** Three types the default camera as a bare `Camera`, which has no field of view. */
function asPerspective(camera: object): PerspectiveCamera | undefined {
  const perspective = camera as PerspectiveCamera;
  return perspective.isPerspectiveCamera ? perspective : undefined;
}

/**
 * Orbit controls, the fit, and the reset. They live inside the canvas because
 * they need the camera, the canvas element and its measured size, and none of
 * those exists outside it.
 *
 * The fit is *deferred until the canvas has been measured*, which is not the
 * same moment as the mount: R3F renders this subtree while the canvas is still
 * at its untouched 300 x 150 default and reports a size of zero, and a fit
 * computed against a zero aspect puts the camera at infinity — a blank panel.
 * So there are two effects rather than one. Fitting to a constant used to hide
 * this, because the fit did not depend on the canvas at all.
 */
/**
 * Half the orbit mark's arms, as a fraction of the world the frame spans where
 * the target is. Small enough to point at a place rather than cover it.
 */
const MARK_SIZE = 0.018;

/**
 * Orbiting about a point in the *system* rather than about wherever panning has
 * left the camera looking.
 *
 * `OrbitControls` turns about `controls.target`, and it also pans by translating
 * the camera **and that target** together — panning, in its model, *is* moving
 * the target. So the two are the same number, and after a pan the thing
 * everything spins about is a spot in mid-air off the side of the picture.
 * Neither half can simply be switched off: the target is where the camera looks,
 * so pinning it undoes the pan, and panning the frustum instead (which does hold
 * it still) stops the cursor tracking what it grabbed.
 *
 * So rotation is taken over here and pan is left alone. A drag rotates the camera
 * **and** the target rigidly about `anchor`, which preserves the offset between
 * them — the pan survives, the view turns about the optics, and `update()` goes
 * on pointing the camera at its target as before.
 *
 * Angles follow `OrbitControls`' own scaling, a full turn per canvas height, so
 * the gesture feels the same as the one it replaces. The polar angle is clamped
 * short of either pole, where the up vector degenerates and the picture flips.
 */
function useOrbitAbout(
  camera: PerspectiveCamera | OrthographicCamera,
  domElement: HTMLElement,
  controls: RefObject<OrbitControls | null>,
  anchor: readonly [number, number, number],
  onGesture: (phase: 'start' | 'end') => void,
) {
  const pivot = useRef(new Vector3(...anchor));
  pivot.current.set(...anchor);

  useEffect(() => {
    let turning = false;
    let lastX = 0;
    let lastY = 0;
    const axis = new Vector3();
    const spin = new Quaternion();
    const arm = new Vector3();

    /** Rotates a point about the pivot, in place. */
    const swing = (point: Vector3): void => {
      arm.copy(point).sub(pivot.current).applyQuaternion(spin);
      point.copy(pivot.current).add(arm);
    };

    const down = (event: PointerEvent): void => {
      // Left is pan, and OrbitControls still owns it.
      if (event.button === 0) {
        return;
      }
      turning = true;
      lastX = event.clientX;
      lastY = event.clientY;
      domElement.setPointerCapture(event.pointerId);
      onGesture('start');
    };

    const move = (event: PointerEvent): void => {
      const orbit = controls.current;
      if (!turning || orbit === null) {
        return;
      }
      const height = domElement.clientHeight || 1;
      const azimuth = (-2 * Math.PI * (event.clientX - lastX)) / height;
      let polar = (-2 * Math.PI * (event.clientY - lastY)) / height;
      lastX = event.clientX;
      lastY = event.clientY;

      // How far the camera already is from the up axis, so a drag cannot be
      // carried over the pole — past it the up vector reverses and the picture
      // turns upside down mid-gesture.
      arm.copy(camera.position).sub(pivot.current);
      const fromPole = arm.angleTo(camera.up);
      const LIMIT = 0.01;
      polar = Math.min(Math.max(polar, LIMIT - (Math.PI - fromPole)), fromPole - LIMIT);

      // Azimuth about the world up, elevation about the camera's own right —
      // which is what makes a sideways drag spin the system and an upward one
      // lift the eye, whatever angle the camera is already at.
      axis.setFromMatrixColumn(camera.matrix, 0);
      spin.setFromAxisAngle(camera.up, azimuth);
      spin.multiply(new Quaternion().setFromAxisAngle(axis, polar));

      swing(camera.position);
      swing(orbit.target);
      orbit.update();
    };

    const stop = (event: PointerEvent): void => {
      if (!turning) {
        return;
      }
      turning = false;
      if (domElement.hasPointerCapture(event.pointerId)) {
        domElement.releasePointerCapture(event.pointerId);
      }
      onGesture('end');
    };

    domElement.addEventListener('pointerdown', down);
    domElement.addEventListener('pointermove', move);
    domElement.addEventListener('pointerup', stop);
    domElement.addEventListener('pointercancel', stop);
    return () => {
      domElement.removeEventListener('pointerdown', down);
      domElement.removeEventListener('pointermove', move);
      domElement.removeEventListener('pointerup', stop);
      domElement.removeEventListener('pointercancel', stop);
    };
  }, [camera, domElement, controls, onGesture]);

  return pivot;
}

function Controls({
  framing,
  tweaks,
  resetSignal,
  subject,
  saved,
  onCamera,
  markColor,
}: {
  framing: Framing;
  tweaks: Tweaks;
  resetSignal: number;
  /**
   * What is being looked at. The *system*, deliberately, and not `framing`:
   * framing is measured from the scene, so it is a new object every time the ray
   * count or the field selection changes, and depending on it here meant that
   * turning the rays from 9 to 11 threw away an orbit the user had set up. The
   * subject of the picture has not changed, so the camera should not move.
   */
  subject: OpticalSystem;
  saved: CameraState | undefined;
  onCamera: ((state: CameraState | undefined) => void) | undefined;
  /** Ink for the orbit-point mark. */
  markColor: string;
}) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const domElement = useThree((state) => state.gl.domElement);
  const controls = useRef<OrbitControls>(null);
  /** Whether the user has framed something since the last deliberate reframe. */
  const touched = useRef(false);
  /** Whether a view has been applied at all — false until the canvas is measured. */
  const settled = useRef(false);
  /**
   * Reported on our own rotate gesture, since `OrbitControls` no longer fires
   * `start`/`end` for one: it still owns pan and dolly, and those go on firing.
   */
  const onGesture = useCallback(
    (phase: 'start' | 'end') => {
      const orbit = controls.current;
      if (phase === 'start') {
        touched.current = true;
        return;
      }
      if (orbit) {
        report.current?.({
          position: camera.position.toArray() as [number, number, number],
          target: orbit.target.toArray() as [number, number, number],
          zoom: camera.zoom,
        });
      }
    },
    [camera],
  );

  // The point the picture turns about: the middle of the system, held there
  // whatever panning does to where the camera happens to be looking.
  const pivot = useOrbitAbout(
    camera as PerspectiveCamera | OrthographicCamera,
    domElement,
    controls,
    framing.target,
    onGesture,
  );

  const lastFov = useRef(tweaks.fieldOfView);
  const lastDistance = useRef(tweaks.cameraDistance);
  const { projection, fieldOfView, fitMargin, cameraDistance } = tweaks;

  // Read through a ref so the listener below can be attached once. An inline
  // callback is a new function every render, and a listener taking it as a
  // dependency would be torn down and rebuilt on each one.
  const report = useRef(onCamera);
  useLayoutEffect(() => {
    report.current = onCamera;
  });

  /**
   * Put the camera somewhere: back where the user left it if they left it
   * anywhere, and otherwise around the whole system.
   *
   * Near and far come from the fit either way, because they are clipping planes
   * for *this* scene — a remembered position says where to stand, not what to
   * be able to see, and a system that has grown since would be sliced by the
   * old ones.
   */
  const applyView = (): void => {
    // Nothing to fit against yet. The measurement effect will call back.
    if (size.width === 0 || size.height === 0) {
      return;
    }
    const placed = placeCamera(framing, tweaks, HOME_TUPLE, size.width, size.height);
    camera.near = placed.near;
    camera.far = placed.far;

    const restoring = !settled.current && saved !== undefined;
    settled.current = true;
    // A remembered view is one the user framed, so it counts as having framed
    // one: a later resize widens the picture and leaves their angle alone.
    touched.current = restoring || touched.current;

    camera.zoom = restoring ? saved.zoom : placed.zoom;
    camera.position.set(...(restoring ? saved.position : placed.position));
    camera.updateProjectionMatrix();

    const orbit = controls.current;
    if (orbit) {
      orbit.target.set(...(restoring ? saved.target : framing.target));
      orbit.update();
    }
  };

  // The latest `applyView`, so the effects below can call it without taking
  // every value it closes over as a dependency of their own — a field of view
  // change would otherwise refit, which is precisely what the dolly below exists
  // to avoid. Declared first, so it is current by the time any of them runs.
  const latestFit = useRef(applyView);
  useLayoutEffect(() => {
    latestFit.current = applyView;
  });

  /**
   * The canvas being measured: once on mount, and again whenever a divider is
   * dragged or a neighbouring panel is closed.
   *
   * The mount is also where a remembered view is put back, which is why this is
   * the effect that runs on both — the fit is *deferred until the canvas has a
   * size*, because R3F renders this subtree while the canvas is still at its
   * untouched 300 x 150 and reports zero, and a fit against a zero aspect puts
   * the camera at infinity.
   *
   * Refitting on a later measurement is right up until the user has framed
   * something themselves; after that a resize widens the picture and leaves
   * their angle alone, as it does in every other 3-D application.
   */
  useLayoutEffect(() => {
    if (!settled.current || !touched.current) {
      latestFit.current();
    }
  }, [camera, size.width, size.height]);

  // A different system is a different subject, so it is framed afresh — unless
  // the user has framed it themselves, in which case Reset view is one click and
  // taking their view away is not.
  useAfterFirst(() => {
    if (!touched.current) {
      latestFit.current();
    }
  }, [subject]);

  // Reset view, and the two tweaks that change what a fit even means. These hand
  // the view back deliberately, so they drop the remembered one and clear the
  // record of the user having set anything up.
  useAfterFirst(() => {
    touched.current = false;
    report.current?.(undefined);
    latestFit.current();
  }, [resetSignal, projection, fitMargin]);

  // What counts as the user framing something: `start` fires on a drag or a
  // wheel, and not on our own `update()`.
  useEffect(() => {
    const orbit = controls.current;
    if (orbit === null) {
      return;
    }
    const onStart = (): void => {
      touched.current = true;
    };
    // The *end* of the gesture is when it is worth recording: an orbit is one
    // gesture however many frames it takes, and reporting per frame would
    // re-render the app sixty times a second over something still in progress.
    const onEnd = (): void => {
      report.current?.({
        position: camera.position.toArray() as [number, number, number],
        target: orbit.target.toArray() as [number, number, number],
        zoom: camera.zoom,
      });
    };
    orbit.addEventListener('start', onStart);
    orbit.addEventListener('end', onEnd);
    return () => {
      orbit.removeEventListener('start', onStart);
      orbit.removeEventListener('end', onEnd);
    };
  }, [camera, domElement]);

  /**
   * The two knobs that slide the camera along its own view ray, applied to
   * wherever it currently is rather than by refitting — so the orbit angle and
   * any zoom the user set up survive being turned.
   *
   * A field of view is only worth turning if the system stays the same size
   * while it turns; otherwise all that happens is a zoom and the perspective
   * looks unchanged. Holding `distance · tan(fov/2)` constant is the dolly zoom:
   * the subject keeps its size, the depth of the picture is what changes.
   * Distance is the plainer of the two — step back and the system shrinks and
   * flattens together, which is the same effect arrived at from the other end.
   *
   * Both are inert on an orthographic camera, which has no field of view and
   * takes its size from zoom rather than from distance.
   */
  useLayoutEffect(() => {
    const perspective = asPerspective(camera);
    const beforeFov = lastFov.current;
    const beforeDistance = lastDistance.current;
    lastFov.current = fieldOfView;
    lastDistance.current = cameraDistance;
    if (perspective === undefined) {
      return;
    }
    if (beforeFov !== fieldOfView || beforeDistance !== cameraDistance) {
      const target = controls.current?.target ?? new Vector3(...framing.target);
      const scale =
        (Math.tan((beforeFov * Math.PI) / 360) / Math.tan((fieldOfView * Math.PI) / 360)) *
        (cameraDistance / beforeDistance);
      const offset = camera.position.clone().sub(target).multiplyScalar(scale);
      camera.position.copy(target).add(offset);
    }
    perspective.fov = fieldOfView;
    perspective.updateProjectionMatrix();
  }, [camera, fieldOfView, cameraDistance, framing]);

  /**
   * A cross through the point everything turns about. Three unit segments, put
   * where the target is and scaled every frame to hold one size on screen — the
   * target is usually nowhere near the camera, so a fixed world size would be a
   * speck from one angle and fill the frame from another.
   *
   * It **moves with a pan**, because `OrbitControls` pans by translating the
   * camera and its target together; in its model panning *is* moving the target.
   * That drift is why the mark exists: holding the point still instead was tried
   * (by panning the frustum rather than the camera, which leaves the target
   * untouched) and the pan stopped feeling like a pan — the cursor no longer
   * stayed on what it had grabbed. Showing where the point went is the cheaper
   * answer, and choosing what to orbit about is the real one.
   */
  const mark = useRef<LineSegments>(null);
  const markGeometry = useMemo(() => {
    const geometry = new BufferGeometry();
    // prettier-ignore
    geometry.setAttribute('position', new Float32BufferAttribute([
      -1, 0, 0,  1, 0, 0,
       0,-1, 0,  0, 1, 0,
       0, 0,-1,  0, 0, 1,
    ], 3));
    return geometry;
  }, []);
  useEffect(() => () => markGeometry.dispose(), [markGeometry]);

  // Damping only settles if the controls are stepped every frame.
  useFrame(() => {
    const orbit = controls.current;
    orbit?.update();

    const cross = mark.current;
    if (!orbit || !cross) {
      return;
    }
    // The pivot, not the target: after a pan those are different points, and the
    // one worth marking is the one the picture turns about.
    cross.position.copy(pivot.current);
    // How much world the frame spans where the target is. For a perspective
    // camera that grows with distance; orthographically it is the frustum,
    // which distance does not change at all.
    const span =
      'isPerspectiveCamera' in camera && camera.isPerspectiveCamera
        ? 2 * camera.position.distanceTo(pivot.current) * Math.tan((camera.fov * Math.PI) / 360)
        : ((camera as OrthographicCamera).top - (camera as OrthographicCamera).bottom) /
          camera.zoom;
    cross.scale.setScalar(span * MARK_SIZE);
  });

  return (
    <>
      <orbitControls
        ref={controls}
        args={[camera, domElement]}
        mouseButtons={MOUSE_BUTTONS}
        enableDamping
        dampingFactor={0.12}
        // Rotation is `useOrbitAbout`'s, so that it turns about the system
        // rather than about wherever a pan has left the target. Pan and dolly
        // stay here, unchanged — a pan that moves the camera and its target
        // together is exactly what keeps the cursor on what it grabbed.
        enableRotate={false}
        // Off: it drags the target toward the cursor, which is a second thing
        // moving the point the mark is meant to be pinned to.
        zoomToCursor={false}
      />
      {/*
        Drawn over everything rather than into the scene. The point turned about
        sits inside the glass as often as not, and a mark you can only see from
        the outside does not answer the question it is there to answer.
      */}
      <lineSegments ref={mark} geometry={markGeometry} renderOrder={999} frustumCulled={false}>
        <lineBasicMaterial color={markColor} depthTest={false} transparent opacity={0.9} />
      </lineSegments>
    </>
  );
}

/**
 * An effect that does not run on mount.
 *
 * Both of the deliberate reframes below are *changes* — a different system, a
 * press of Reset view — and neither has happened on the first render. Running
 * them there would have Reset view clear a remembered camera the moment the
 * panel opened, which is the one thing that view is for.
 */
function useAfterFirst(run: () => void, deps: unknown[]): void {
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    run();
    // The caller names what this watches; `run` is read fresh each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

interface Framing extends SystemExtent {
  axisFrom: number;
  axisTo: number;
}

/**
 * Measures the system. *Where the camera goes* is a separate question, answered
 * by `placeCamera` inside the canvas — because it depends on the canvas's aspect
 * and on the field of view, neither of which is knowable out here.
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

  return {
    target: [sphere.center.x, sphere.center.y, sphere.center.z],
    halfHeight,
    halfLength,
    radius,
    axisFrom: scene.bounds.min[2],
    axisTo: scene.bounds.max[2],
  };
}
