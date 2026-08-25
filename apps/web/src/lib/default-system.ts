import { OpticalSystem, Surface } from '@isaac/optical-core';
import { GLASS_CATALOG } from './materials.ts';

/**
 * A 100 mm f/5 cemented doublet, so the app opens on something real rather than
 * an empty grid. Curvatures are the classic crown/flint prescription; the
 * glasses come from the SCHOTT catalog.
 */
export function defaultSystem(): OpticalSystem {
  const crown = GLASS_CATALOG.get('N-BK7')!;
  const flint = GLASS_CATALOG.get('F2')!;

  return new OpticalSystem({
    name: 'Cemented doublet',
    units: 'mm',
    wavelengthsNm: [486.1327, 587.5618, 656.2725],
    primaryWavelengthIndex: 1,
    fields: [{ angleDeg: 0 }, { angleDeg: 3 }, { angleDeg: 5 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 92.847,
        thickness: 6,
        semiDiameter: 15,
        material: crown,
        isStop: true,
        comment: 'Crown front',
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: -30.716,
        thickness: 3,
        semiDiameter: 15,
        material: flint,
        comment: 'Cemented interface',
      }),
      new Surface({
        id: 's3',
        type: 'STANDARD',
        radius: -78.197,
        thickness: 97.376,
        semiDiameter: 15,
        comment: 'Flint rear',
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });
}

/**
 * The blank page the New button starts from: OBJECT, one flat surface, IMAGE.
 *
 * Not literally empty, though the model would allow that — a design needs a
 * first surface and a stop before it is anything at all, and putting them in
 * saves the two steps every new system would otherwise begin with. The surface
 * is a plane in air, so it is a place to put a radius and a glass rather than a
 * lens anyone has to undo, and it carries the stop because with nothing in front
 * of it the entrance pupil *is* the stop, sitting at z = 0 where it is easiest to
 * reason about.
 *
 * The rest is what a designer sets first and changes rarely: millimeters, the
 * F/d/C lines with d primary, and one axial field. The 20 mm entrance pupil and
 * the 10 mm semi-diameter are the same aperture said twice on purpose — the beam
 * fills the stop exactly, so no ray starts out vignetted, and the pupil is a real
 * one the moment a curvature is typed. `ENTRANCE_PUPIL_DIAMETER` rather than
 * `FLOAT_BY_STOP` because a float would resize the beam every time the stop's
 * semi-diameter was edited, which is surprising on a system still being built.
 *
 * A plane in air has no power, so First Order opens on an honest afocal
 * summary — power 0, an infinite focal length, and the entrance pupil sitting on
 * the stop — rather than on the error a system with no surface at all produces.
 * Real numbers appear as soon as a radius or a glass is typed.
 */
export function emptySystem(): OpticalSystem {
  return new OpticalSystem({
    name: 'New system',
    units: 'mm',
    wavelengthsNm: [486.1327, 587.5618, 656.2725],
    primaryWavelengthIndex: 1,
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 10,
        semiDiameter: 10,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });
}

let nextId = 0;

/** A unique id for a surface added in the editor. */
export function newSurfaceId(): string {
  nextId += 1;
  return `s-new-${nextId}`;
}
