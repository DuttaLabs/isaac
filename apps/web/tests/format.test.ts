import assert from 'node:assert/strict';
import test from 'node:test';
import { INFINITY_TEXT, formatLength, formatOptional, parseLength } from '../src/lib/format.ts';

test('infinity prints as Inf, in both signs', () => {
  assert.equal(formatLength(Infinity), 'Inf');
  assert.equal(formatLength(-Infinity), '-Inf');
  assert.equal(formatOptional(Infinity), 'Inf');
  assert.equal(formatOptional(-Infinity), '-Inf');
  assert.equal(INFINITY_TEXT, 'Inf');
});

test('what is printed can be typed back in', () => {
  // The editor round-trips through these two, so a change to the printed form
  // that the parser does not know about would strand the user: the cell would
  // show a value it then refuses to accept.
  for (const value of [Infinity, -Infinity, 0, 12.5, -3, 1e-4]) {
    assert.equal(parseLength(formatLength(value), NaN), value, `${value} does not round-trip`);
  }
});

test('infinity is accepted however it is written', () => {
  for (const text of ['Inf', 'inf', 'INF', 'Infinity', 'infinity', '∞', ' inf ']) {
    assert.equal(parseLength(text, 0), Infinity, `${text} should read as +∞`);
  }
  // Both the ASCII hyphen and the typographic minus, since either may be pasted.
  for (const text of ['-Inf', '−Inf', '-infinity', '−∞']) {
    assert.equal(parseLength(text, 0), -Infinity, `${text} should read as −∞`);
  }
});

test('ordinary numbers are unaffected', () => {
  assert.equal(formatLength(0), '0');
  assert.equal(formatLength(2.5), '2.5');
  assert.equal(formatLength(1 / 3), '0.3333');
  assert.equal(parseLength('', 7), 7, 'blank falls back');
  assert.equal(parseLength('nonsense', 7), 7, 'unparseable falls back');
  assert.equal(formatOptional(undefined), '—');
});
