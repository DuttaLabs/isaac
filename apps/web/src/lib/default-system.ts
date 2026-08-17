import { AIR, OpticalSystem, Surface, type Material } from '@isaac/optical-core';
import { SCHOTT } from '@isaac/glass-catalog';

/** The catalog used for glass lookup, tolerant of obsolete names from old files. */
export const GLASS_CATALOG = SCHOTT.with({ allowLegacyNames: true });

/** Resolves a glass name typed in the editor; blank or `AIR` means air. */
export function resolveGlass(name: string): Material | undefined {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'AIR') {
    return AIR;
  }
  return GLASS_CATALOG.get(trimmed);
}

/** The name to show in the editor for a material. */
export function glassName(material: Material): string {
  return material.name === 'AIR' ? '' : material.name;
}

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

let nextId = 0;

/** A unique id for a surface added in the editor. */
export function newSurfaceId(): string {
  nextId += 1;
  return `s-new-${nextId}`;
}
