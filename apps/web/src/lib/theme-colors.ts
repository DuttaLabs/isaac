import { useEffect, useState } from 'react';

/**
 * The theme's colors as values WebGL can use.
 *
 * The SVG views hand `var(--wave-blue)` straight to an attribute and let CSS
 * resolve it, which is why they follow the theme for free. A WebGL material
 * needs a real color, so the 3-D view reads the same custom properties off the
 * document and re-reads them whenever the theme changes — the tokens in
 * `theme.css` stay the single definition, and the two layouts cannot drift into
 * different palettes.
 */

/** Every token the 3-D layout draws with, and what it falls back to. */
const TOKENS = {
  background: ['--surface-1', '#fcfcfb'],
  glass: ['--accent', '#2a78d6'],
  faulty: ['--danger', '#c0362f'],
  surface: ['--glass-stroke', '#6f6d66'],
  mirror: ['--mirror', '#5f7180'],
  stop: ['--stop-mark', '#0b0b0b'],
  highlight: ['--surface-highlight', '#fcba05'],
  axis: ['--axis', '#b5b4ac'],
} as const;

const WAVELENGTH_TOKENS = ['--wave-blue', '--wave-green', '--wave-red'] as const;

export interface ThemeColors {
  background: string;
  glass: string;
  faulty: string;
  surface: string;
  mirror: string;
  stop: string;
  highlight: string;
  axis: string;
  /** Resolved wavelength colors, keyed by the custom property name. */
  wavelengths: Record<string, string>;
}

function read(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const value = (token: string, fallback: string): string => {
    const resolved = style.getPropertyValue(token).trim();
    return resolved === '' ? fallback : resolved;
  };

  const wavelengths: Record<string, string> = {};
  for (const token of WAVELENGTH_TOKENS) {
    wavelengths[token] = value(token, '#808080');
  }

  return {
    background: value(...TOKENS.background),
    glass: value(...TOKENS.glass),
    faulty: value(...TOKENS.faulty),
    surface: value(...TOKENS.surface),
    mirror: value(...TOKENS.mirror),
    stop: value(...TOKENS.stop),
    highlight: value(...TOKENS.highlight),
    axis: value(...TOKENS.axis),
    wavelengths,
  };
}

export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(read);

  useEffect(() => {
    const refresh = (): void => setColors(read());

    // Two ways the theme moves: the in-app toggle stamps `data-theme` on the
    // root, and with the toggle on "system" nothing is stamped at all and only
    // the OS preference separates light from dark.
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', refresh);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', refresh);
    };
  }, []);

  return colors;
}
