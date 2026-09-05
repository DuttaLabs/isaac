/**
 * Checks a lens file against what OpticStudio says about it.
 *
 *     npm run compare -- <lens.zmx> <prescription.txt> [options]
 *
 * The method is the point. Isaac's own tests can only check Isaac against
 * Isaac's understanding, so a convention held wrongly in both is invisible to
 * all of them at once — which is exactly what happened with the effective focal
 * length, wrong on immersed systems with 535 tests agreeing. A second program's
 * arithmetic is the only thing that finds that class of bug, and OpticStudio's
 * prescription export is that arithmetic in a form a script can read.
 *
 * This lives at the root rather than inside a package because it is what wires
 * the reader to the glass catalog — `apps/web`'s job too, and one `zemax-io`
 * must not do for itself.
 *
 * Options:
 *   --all              list every check, not just the ones worth looking at
 *   --wavelength <nm>  compare at this wavelength instead of the report's primary
 *   --weak <n>         flag agreements pinned to fewer than n digits (default 3)
 *   --json             emit the whole comparison as JSON
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ALL_GLASSES } from '@isaac/glass-catalog';
import {
  comparePrescription,
  importZmx,
  parsePrescription,
  primaryWavelengthNm,
  type PrescriptionCheck,
} from '@isaac/zemax-io';

interface Options {
  lensPath: string;
  reportPath: string;
  all: boolean;
  json: boolean;
  weakBelow: number;
  wavelengthNm: number | undefined;
}

function parseArguments(argv: readonly string[]): Options {
  const positional: string[] = [];
  let all = false;
  let json = false;
  let weakBelow = 3;
  let wavelengthNm: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--all') all = true;
    else if (argument === '--json') json = true;
    else if (argument === '--weak') weakBelow = Number(argv[(index += 1)]);
    else if (argument === '--wavelength') wavelengthNm = Number(argv[(index += 1)]);
    else if (argument.startsWith('-')) throw new Error(`Unknown option ${argument}`);
    else positional.push(argument);
  }

  if (positional.length !== 2) {
    throw new Error('Usage: npm run compare -- <lens.zmx> <prescription.txt> [options]');
  }
  return {
    lensPath: positional[0]!,
    reportPath: positional[1]!,
    all,
    json,
    weakBelow,
    wavelengthNm,
  };
}

const ESC = String.fromCharCode(27);
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RESET = `${ESC}[0m`;

const color = process.stdout.isTTY === true;
const paint = (code: string, text: string): string => (color ? `${code}${text}${RESET}` : text);

function interval(check: PrescriptionCheck): string {
  if (Number.isNaN(check.low) || check.low === check.high) return '';
  const span = (value: number) => (Number.isFinite(value) ? value.toPrecision(10) : String(value));
  return `  ${paint(DIM, `[${span(check.low)}, ${span(check.high)}]`)}`;
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));

  const { system, warnings: importWarnings } = importZmx(readFileSync(options.lensPath), {
    resolveMaterial: ALL_GLASSES.resolver(),
  });
  const prescription = parsePrescription(readFileSync(options.reportPath));
  const comparison = comparePrescription(system, prescription, {
    wavelengthNm: options.wavelengthNm,
  });

  const wavelengthNm =
    options.wavelengthNm ?? primaryWavelengthNm(prescription) ?? system.primaryWavelengthNm;

  if (options.json) {
    // The checks and nothing else: a `ZmxPrescription` carries Maps, which
    // `JSON.stringify` turns into empty objects without saying so.
    process.stdout.write(
      `${JSON.stringify(
        {
          lens: options.lensPath,
          report: prescription.file,
          exported: prescription.date,
          precision: prescription.precision,
          wavelengthNm,
          ...comparison,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  console.log(paint(BOLD, `\n${basename(options.lensPath)} against OpticStudio`));
  console.log(paint(DIM, `  report      ${prescription.file || basename(options.reportPath)}`));
  if (prescription.date !== '') console.log(paint(DIM, `  exported    ${prescription.date}`));
  console.log(
    paint(
      DIM,
      `  read at     ${prescription.precision.maskedDecimals} masked decimals, ` +
        `${prescription.precision.significantDigits} significant figures`,
    ),
  );
  console.log(paint(DIM, `  compared at ${wavelengthNm} nm\n`));

  // Per-section tallies, so a whole block going wrong is visible at a glance.
  for (const section of new Set(comparison.checks.map((check) => check.section))) {
    const inSection = comparison.checks.filter((check) => check.section === section);
    const count = (outcome: string) =>
      inSection.filter((check) => check.outcome === outcome).length;
    const parts = [paint(GREEN, `${count('agree')} agree`)];
    if (count('disagree') > 0) parts.push(paint(RED, `${count('disagree')} disagree`));
    if (count('unchecked') > 0) parts.push(paint(DIM, `${count('unchecked')} unchecked`));
    console.log(`  ${section.padEnd(24)}${parts.join('   ')}`);
  }

  const disagreements = comparison.checks.filter((check) => check.outcome === 'disagree');
  if (disagreements.length > 0) {
    console.log(paint(BOLD, '\n  Disagreements'));
    for (const check of disagreements) {
      console.log(`    ${paint(RED, 'x')} ${check.section} / ${check.item}`);
      console.log(`        OpticStudio  ${check.expected}${interval(check)}`);
      console.log(`        Isaac        ${paint(RED, check.actual)}`);
      if (check.note !== undefined) console.log(`        ${paint(DIM, check.note)}`);
    }
  }

  // An agreement is only as strong as the digits it was checked against, so a
  // value the report pinned to nothing must not read as a pass.
  // Weak means the *licence* withheld the digits. A value printed in full, like
  // a conic of 0 or a thickness of 40, pins few digits because it needed few.
  const weak = comparison.checks.filter(
    (check) => check.outcome === 'agree' && check.masked > 0 && check.pinned < options.weakBelow,
  );
  if (weak.length > 0) {
    console.log(paint(BOLD, `\n  Agreed, but on fewer than ${options.weakBelow} pinned digits`));
    const shown = options.all ? weak : weak.slice(0, 8);
    for (const check of shown) {
      console.log(
        `    ${paint(YELLOW, '~')} ${`${check.section} / ${check.item}`.padEnd(46)}  ` +
          paint(DIM, `${check.expected} pins ${check.pinned}`),
      );
    }
    if (shown.length < weak.length) {
      console.log(paint(DIM, `    ... and ${weak.length - shown.length} more (--all)`));
    }
  }

  const unchecked = comparison.checks.filter((check) => check.outcome === 'unchecked');
  if (unchecked.length > 0) {
    const reasons = new Map<string, number>();
    for (const check of unchecked) reasons.set(check.actual, (reasons.get(check.actual) ?? 0) + 1);
    console.log(paint(BOLD, '\n  Unchecked'));
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
      console.log(paint(DIM, `    ${String(count).padStart(4)}  ${reason}`));
    }
  }

  if (options.all) {
    console.log(paint(BOLD, '\n  All checks'));
    for (const check of comparison.checks) {
      const mark =
        check.outcome === 'agree'
          ? paint(GREEN, 'ok')
          : check.outcome === 'disagree'
            ? paint(RED, ' x')
            : paint(DIM, ' -');
      console.log(
        `    ${mark} ${`${check.section} / ${check.item}`.padEnd(42)}` +
          `${check.expected.padEnd(18)} ${check.actual}`,
      );
    }
  }

  for (const warning of comparison.warnings) console.log(paint(YELLOW, `\n  ! ${warning}`));

  const unmodeled = importWarnings.filter((w) => w.code === 'UNMODELED_SURFACE_TOKENS');
  if (unmodeled.length > 0) {
    console.log(
      paint(
        YELLOW,
        `\n  ! ${unmodeled.length} surface(s) carry records Isaac does not model, ` +
          'so the design compared is not the whole file.',
      ),
    );
  }

  console.log(
    `\n  ${paint(GREEN, `${comparison.agreed} agree`)}   ` +
      `${comparison.disagreed > 0 ? paint(RED, `${comparison.disagreed} disagree`) : '0 disagree'}   ` +
      paint(DIM, `${comparison.unchecked} unchecked\n`),
  );

  process.exitCode = comparison.disagreed > 0 ? 1 : 0;
}

main();
