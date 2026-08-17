import {
  AIR,
  ConstantMaterial,
  ModelGlassMaterial,
  SPECTRAL_LINES,
  type Material,
} from '@isaac/optical-core';
import { SCHOTT } from '@isaac/glass-catalog';
import { MODEL_GLASS_NAME } from '@isaac/zemax-io';
import { attempt, type Result } from './result.ts';

/**
 * What the editor's Material column understands: a catalog name, air, or a
 * *model glass* — a glass given by its numbers instead of its name.
 *
 * Model glasses matter because most designs taken from patents have no glass
 * names in them at all: a patent quotes nd and Vd and leaves the melt to the
 * manufacturer, so a lens file written from one carries `___BLANK` where a name
 * would go. Those numbers are the prescription, so the editor shows them in
 * their own column rather than hiding them inside a material's name.
 */

/** The catalog used for glass lookup, tolerant of obsolete names from old files. */
export const GLASS_CATALOG = SCHOTT.with({ allowLegacyNames: true });

/** What the Material column shows, and what you type there, for a model glass. */
export const MODEL_MATERIAL_LABEL = 'MODEL';

/**
 * Names given to a glass described by numbers: `MODEL …` by this editor, and
 * `___BLANK …` by the lens-file importer, which keeps the file's own word for it.
 * Either way the glass is a set of parameters, so the editor treats them alike.
 */
const MODEL_NAME_PREFIXES = [MODEL_MATERIAL_LABEL, MODEL_GLASS_NAME] as const;

/**
 * Where a model glass starts when there is nothing to convert. Deliberately
 * round: it is a placeholder to type over, and should not be mistaken for a real
 * melt the way 1.5168/64.17 (N-BK7) would be.
 */
const PLACEHOLDER = { nd: 1.5, abbeNumber: 50 } as const;

/** The three numbers a model glass is built from. */
export interface ModelGlassParameters {
  nd: number;
  abbeNumber: number;
  /** Deviation of the partial dispersion from the normal line; 0 is an ordinary glass. */
  deltaPgF: number;
}

/**
 * The parameters behind a material, or undefined if it is not a model glass.
 *
 * Two shapes count. A {@link ModelGlassMaterial} carries its parameters, and is
 * recognized by type. A file that gives an index but `Vd = 0` — "no dispersion"
 * — is imported as a plain {@link ConstantMaterial}, which has no parameters to
 * carry, so it is recognized by the name the importer gave it and its Abbe
 * number is reported as the 0 the file meant.
 */
export function modelGlassParameters(material: Material): ModelGlassParameters | undefined {
  if (material instanceof ModelGlassMaterial) {
    return {
      nd: material.nd,
      abbeNumber: material.abbeNumber,
      deltaPgF: material.deltaPgF,
    };
  }
  if (MODEL_NAME_PREFIXES.some((prefix) => material.name.startsWith(prefix))) {
    const nd = attempt(() => material.indexAt(SPECTRAL_LINES.d));
    return nd.ok ? { nd: nd.value, abbeNumber: 0, deltaPgF: 0 } : undefined;
  }
  return undefined;
}

/** True for a glass described by numbers rather than named, however it got here. */
export function isModelGlass(material: Material): boolean {
  return modelGlassParameters(material) !== undefined;
}

/** The name to show in the Material column; air is blank, a model glass is MODEL. */
export function materialLabel(material: Material): string {
  if (material.name === AIR.name) {
    return '';
  }
  return isModelGlass(material) ? MODEL_MATERIAL_LABEL : material.name;
}

/**
 * The material a typed Material cell means. Undefined for a name we have no
 * glass for, which the cell shows as invalid rather than committing.
 */
export function materialFromText(text: string, current: Material): Material | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.toUpperCase() === AIR.name) {
    return AIR;
  }
  if (trimmed.toUpperCase() === MODEL_MATERIAL_LABEL) {
    // Already a model glass: keep this one. Rebuilding it from the label would
    // throw away the parameters, which is the opposite of what leaving the cell
    // alone should do.
    return isModelGlass(current) ? current : modelGlassFrom(current);
  }
  return GLASS_CATALOG.get(trimmed);
}

/**
 * Converts a material to a model glass with the same nd and Abbe number.
 *
 * The numbers come from the glass itself, measured at the three lines the Abbe
 * number is defined by, so turning N-BK7 into a model glass gives back N-BK7's
 * own 1.5168/64.17 and traces within 1e-4 of it across the visible. A medium
 * with no dispersion to measure — air, or an unknown-glass placeholder — keeps
 * whatever index it has and takes the placeholder Abbe number; air's index of
 * exactly 1 is not a glass, so that falls back entirely.
 */
export function modelGlassFrom(material: Material): ModelGlassMaterial {
  const measured = attempt(() => {
    const nd = material.indexAt(SPECTRAL_LINES.d);
    const principalDispersion =
      material.indexAt(SPECTRAL_LINES.F) - material.indexAt(SPECTRAL_LINES.C);
    return { nd, abbeNumber: (nd - 1) / principalDispersion };
  });

  const nd = measured.ok && measured.value.nd > 1 ? measured.value.nd : PLACEHOLDER.nd;
  const abbeNumber =
    measured.ok && measured.value.abbeNumber > 0 && Number.isFinite(measured.value.abbeNumber)
      ? measured.value.abbeNumber
      : PLACEHOLDER.abbeNumber;

  return new ModelGlassMaterial(modelGlassName(nd, abbeNumber, 0), nd, abbeNumber);
}

/**
 * The parameters as the Model glass column shows them, or undefined when the
 * material is a named glass and the column does not apply. ΔPg,F is left off
 * when it is zero, which is every glass on the normal line and every one the
 * importer builds.
 */
export function modelGlassText(material: Material): string | undefined {
  const parameters = modelGlassParameters(material);
  if (parameters === undefined) {
    return undefined;
  }
  const { nd, abbeNumber, deltaPgF } = parameters;
  const shown = `${nd.toFixed(4)} / ${abbeNumber.toFixed(2)}`;
  return deltaPgF === 0 ? shown : `${shown} / ${deltaPgF.toFixed(4)}`;
}

/** What the Model glass column accepts, spelled out for its tooltip. */
export const MODEL_GLASS_HINT =
  'Index nd and Abbe number Vd, as "1.5168 / 64.17", the way a patent gives a glass. ' +
  'A third number is ΔPg,F, the deviation from the normal line (small: −0.01 to +0.05). ' +
  'A Vd of 0 means an index with no dispersion.';

/**
 * Reads a Model glass cell. Separators are loose — `/`, comma or space — because
 * the column shows one value made of three numbers and there is no reason to be
 * fussy about which of those the user types between them.
 */
export function modelGlassFromText(text: string): Result<Material> {
  return attempt(() => {
    // U+2212 is what a copy-paste from a document brings in for a minus sign,
    // and ΔPg,F is the one parameter here that is often negative.
    const parts = text
      .replace(/−/g, '-')
      .trim()
      .split(/[\s,/]+/)
      .filter(Boolean);
    if (parts.length < 2 || parts.length > 3) {
      throw new RangeError(
        `Give an index and an Abbe number, as "1.5168 / 64.17", optionally followed by ΔPg,F; got "${text.trim()}".`,
      );
    }

    const values = parts.map((part) => {
      const value = Number(part);
      if (!Number.isFinite(value)) {
        throw new RangeError(`"${part}" is not a number.`);
      }
      return value;
    });
    const [nd, abbeNumber, deltaPgF = 0] = values as [number, number, number?];

    if (!(nd > 0)) {
      throw new RangeError(`An index of ${nd} is not a material; nd must be positive.`);
    }
    if (abbeNumber < 0) {
      throw new RangeError(
        `An Abbe number of ${abbeNumber} would disperse backwards; use 0 for no dispersion.`,
      );
    }

    // Vd = 0 is how a lens file says "an index and nothing more", and the
    // importer reads it that way, so the editor writes it back the same way.
    if (abbeNumber === 0) {
      return new ConstantMaterial(`${MODEL_MATERIAL_LABEL} n=${nd.toFixed(4)}`, nd);
    }
    return new ModelGlassMaterial(modelGlassName(nd, abbeNumber, deltaPgF), nd, abbeNumber, {
      deltaPgF,
    });
  });
}

/** Model glasses have no name of their own, so they are named after their numbers. */
function modelGlassName(nd: number, abbeNumber: number, deltaPgF: number): string {
  const base = `${MODEL_MATERIAL_LABEL} ${nd.toFixed(4)}/${abbeNumber.toFixed(2)}`;
  return deltaPgF === 0 ? base : `${base}/${deltaPgF.toFixed(4)}`;
}
