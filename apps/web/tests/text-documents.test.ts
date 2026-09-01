import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findMatches,
  highlightZmxLine,
  languageOf,
  linesOf,
  stepMatch,
} from '../src/lib/text-documents.ts';
import { MENU_LIMIT, lensFileRecents, readRecents, withRecent } from '../src/lib/recent-files.ts';

/** The role of the record's token — the first span that is not the indent. */
const tokenRole = (line: string): string | undefined =>
  highlightZmxLine(line).find((span) => span.text.trim() !== '')?.role;
const texts = (line: string): string[] => highlightZmxLine(line).map((span) => span.text);

test('a highlighted line is the line: every character survives, in order', () => {
  // The property that matters most and is easiest to lose: a highlighter that
  // drops the last token or eats an indent renders a file that is subtly not
  // the file.
  for (const line of [
    'SURF 4',
    '  TYPE STANDARD',
    '  CURV -3.286664883100000149E-03 0 0 0 0 ""',
    '  GLAS MIRROR 0 0 0 0 0 0 0 0 0 0',
    'NOTE 0 This lens is afocal in image space.',
    '',
    '   ',
    'UNKNOWNTOKEN 1 2 3',
  ]) {
    assert.equal(texts(line).join(''), line, `rebuilt "${texts(line).join('')}" from "${line}"`);
  }
});

test('the color of a token is what the reader does with it', () => {
  // Not a list kept here: `zmxTokenRole` is the importer's own answer, so a
  // record that gains a meaning gains its color in the same commit.
  // SURF and STOP are picked out for the eye rather than by the reader: both are
  // records the importer interprets, and which of them is worth finding at a
  // glance is a question about *reading* a file.
  assert.equal(tokenRole('SURF 4'), 'surface');
  assert.equal(tokenRole('  STOP'), 'stop');
  assert.equal(tokenRole('  CURV 0.5 0 0'), 'prescription');
  assert.equal(tokenRole('  CLAP 0 55 0'), 'prescription');
  assert.equal(tokenRole('ENPD 100'), 'system');
  // A record that would move a ray and is *not* modeled is the one warned about.
  assert.equal(tokenRole('  UDAD 0 "slit.UDA" 1'), 'unmodeled');
  // And one that has since been modeled is no longer flagged as a gap.
  assert.equal(tokenRole('  SPID 2 3 0'), 'prescription');
  // And one that is skipped with nothing optical resting on it stays quiet.
  assert.equal(tokenRole('  HIDE 0 0 0'), 'annotation');
});

test('indentation is kept, because it is what marks a surface block', () => {
  const spans = highlightZmxLine('  DISZ 5');
  assert.equal(spans[0]?.text, '  ');
  assert.equal(spans[1]?.text, 'DISZ');
  assert.equal(spans[1]?.role, 'prescription');
});

test('free-text records are not picked apart into numbers', () => {
  // `NOTE 0 The 3 mirrors...` has words that parse as numbers, and coloring
  // them would make a sentence look like data.
  const spans = highlightZmxLine('NOTE 0 The 3 mirrors are conics.');
  assert.equal(spans.length, 2);
  assert.equal(spans[1]?.role, 'string');
});

test('search finds every match in reading order, without overlapping itself', () => {
  const lines = ['SURF 1', '  GLAS N-BK7', 'SURF 2', 'aaaa'];
  assert.deepEqual(
    findMatches(lines, 'SURF').map((match) => match.line),
    [0, 2],
  );
  // Case-insensitive by default: `surf` and `SURF` are the same record.
  assert.equal(findMatches(lines, 'surf').length, 2);
  assert.equal(findMatches(lines, 'surf', true).length, 0);
  // Advancing past each hit: `aaaa` holds two `aa`, not three.
  assert.equal(findMatches(lines, 'aa').length, 2);
  assert.deepEqual(findMatches(lines, ''), []);
});

test('stepping through matches wraps at both ends', () => {
  assert.equal(stepMatch(3, 2, 1), 0);
  assert.equal(stepMatch(3, 0, -1), 2);
  // No matches: there is nowhere to step to, and no crash either.
  assert.equal(stepMatch(0, 0, 1), 0);
});

test('a lens file is highlighted, a text file is not', () => {
  assert.equal(languageOf('Hubble.zmx'), 'zmx');
  assert.equal(languageOf('HUBBLE.ZMX'), 'zmx');
  assert.equal(languageOf('schott.agf'), 'zmx');
  assert.equal(languageOf('notes.txt'), undefined);
});

test('a trailing newline is a line, so the gutter counts what the file has', () => {
  assert.deepEqual(linesOf('a\nb\n'), ['a', 'b', '']);
  assert.deepEqual(linesOf(''), ['']);
});

test('opening a file again moves it up the recent list rather than repeating it', () => {
  const first = withRecent([], 'Hubble.zmx', 1);
  const second = withRecent(first, 'Gregorian.zmx', 2);
  const again = withRecent(second, 'Hubble.zmx', 3);

  assert.deepEqual(
    again.map((one) => one.name),
    ['Hubble.zmx', 'Gregorian.zmx'],
  );
  assert.equal(again[0]?.openedAt, 3);
  // One entry per name is also what keeps a stored handle from being orphaned
  // under a key nothing points at any more.
  assert.equal(new Set(again.map((one) => one.key)).size, again.length);
});

test('a recent list that has been tampered with does not take the panel down', () => {
  assert.deepEqual(readRecents(null), []);
  assert.deepEqual(readRecents('not json'), []);
  assert.deepEqual(readRecents('{"not":"an array"}'), []);
  // Entries that are the right shape survive; the rest are dropped.
  const mixed = readRecents('[{"key":"a","name":"a.zmx","openedAt":1},{"key":2},null]');
  assert.deepEqual(mixed, [{ key: 'a', name: 'a.zmx', openedAt: 1 }]);
});

test('the app bar is offered lens files only, and never more than a menu holds', () => {
  // One list serves both the app bar and the text panel, so it holds whatever
  // either has opened. The app bar loads a *design*, and a .txt offered here
  // would promise a lens that is not there and fail after the click.
  const mixed = [
    { key: 'file:notes.txt', name: 'notes.txt', openedAt: 3 },
    { key: 'file:Hubble.zmx', name: 'Hubble.zmx', openedAt: 2 },
    { key: 'file:Gregorian.ZMX', name: 'Gregorian.ZMX', openedAt: 1 },
  ];
  assert.deepEqual(
    lensFileRecents(mixed).map((one) => one.name),
    // Upper case too: a .zmx is a .zmx however the file happens to spell it,
    // and half the sample corpus shouts it.
    ['Hubble.zmx', 'Gregorian.ZMX'],
  );

  // The stored list is longer than any menu precisely so that filtering it
  // still fills one — a run of text files must not empty the app bar's ten.
  const many = Array.from({ length: 25 }, (_, index) => ({
    key: `file:lens${index}.zmx`,
    name: `lens${index}.zmx`,
    openedAt: index,
  }));
  assert.equal(lensFileRecents(many).length, MENU_LIMIT);
  assert.equal(lensFileRecents(many)[0]?.name, 'lens0.zmx');
});
