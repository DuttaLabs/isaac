import { useEffect, useMemo, useRef } from 'react';
import { Canvas, extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber';
import { Box3, DoubleSide, MOUSE, Sphere, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { OpticalSystem } from '@isaac/optical-core';
import { buildOpticalScene, type OpticalScene } from '@isaac/three-optics';
import type { LayoutTrace } from '../lib/analysis.ts';
import { wavelengthStyle } from '../lib/wavelengths.ts';
import { useThemeColors } from '../lib/theme-colors.ts';

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

/**
 * The system as a solid, seen from wherever the user puts the camera.
 *
 * Geometry comes from `@isaac/three-optics`, which knows nothing about React;
 * this file is the mount and the controls. Colors are resolved from the same
 * theme tokens the SVG views use, so the two layouts cannot drift apart.
 */
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

  const scene = useMemo(
    () => buildOpticalScene(system, traces, { defaultSemiDiameter }),
    [system, traces, defaultSemiDiameter],
  );

  // Built outside the reconciler, so nothing disposes it for us.
  useEffect(() => () => scene.dispose(), [scene]);

  const framing = useMemo(() => frameFor(scene), [scene]);

  return (
    <div className="layout-3d">
      <Canvas
        dpr={[1, 2]}
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
          const style = wavelengthStyle(
            system.wavelengthsNm[bundle.wavelengthIndex] ?? 550,
            bundle.wavelengthIndex,
          );
          return (
            <lineSegments key={`rays-${index}`} geometry={bundle.geometry}>
              <lineBasicMaterial
                color={colors.wavelengths[style.colorVariable] ?? colors.surface}
                transparent
                opacity={bundle.blocked ? 0.16 : 0.7}
              />
            </lineSegments>
          );
        })}
      </Canvas>
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
