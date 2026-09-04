/**
 * The panels the workspace can show, and what they are called.
 *
 * This lives apart from both the panel chrome and the placement machinery
 * because all of them need it: `Panel` offers the list in its header dropdown,
 * and `workspace.ts` arranges them. The order is the order of the dropdown.
 *
 * **Every analysis is a panel of its own.** The ray fan and the spot diagram
 * were one Analysis panel showing both, which meant you could never have two
 * fans at different fields side by side — the one arrangement a fan is actually
 * read in. Splitting them is also what makes the rest of the analyses cheap:
 * a new plot type is another entry here, and the dropdown offers it with nothing
 * else changed.
 *
 * **Layout 2D and Layout 3D are two panels, not one panel with a switch.** That
 * follows from the rule that two copies of a panel behave identically: a single
 * Layout panel carrying a 2D/3D toggle could never be opened twice to show a
 * cross-section beside a solid, because the second copy would mirror the first
 * and both would show the same thing. Anything two copies must be able to
 * differ in has to be a difference of *panel*, not a control inside one.
 */
export const PANELS = [
  'source',
  'system',
  'firstOrder',
  'layout2d',
  'layout3d',
  'rayFan',
  'spot',
  'textEditor',
  'session',
  'help',
] as const;

export type PanelId = (typeof PANELS)[number];

export const PANEL_TITLES: Record<PanelId, string> = {
  source: 'Source object',
  system: 'Optical system',
  firstOrder: 'First order',
  layout2d: 'Layout 2D',
  layout3d: 'Layout 3D',
  rayFan: 'Ray fan',
  spot: 'Spot diagram',
  textEditor: 'Text editor',
  session: 'Session',
  help: 'Help',
};
