import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestedFileName } from '../src/lib/save-file.ts';

test('a lens name becomes a filename without losing its words', () => {
  // Lens names are prose, and this is only a suggestion the user can overtype —
  // so the words are kept and joined rather than truncated to a slug.
  assert.equal(
    suggestedFileName('A SIMPLE DOUBLET USING A CROWN AND A FLINT.', '.zmx'),
    'A-SIMPLE-DOUBLET-USING-A-CROWN-AND-A-FLINT.zmx',
  );
  assert.equal(suggestedFileName('Cemented doublet', '.zmx'), 'Cemented-doublet.zmx');
});

test('characters a filesystem objects to are replaced, not deleted', () => {
  // Dropping them would run words together: "f/2 lens" must not become "f2-lens"
  // read as one word, and a path separator must never survive into a filename.
  assert.equal(suggestedFileName('f/2 lens', '.zmx'), 'f-2-lens.zmx');
  assert.equal(suggestedFileName('a\\b:c*d?e"f<g>h|i', '.zmx'), 'a-b-c-d-e-f-g-h-i.zmx');
});

test('a name that survives as nothing still yields a usable file', () => {
  for (const empty of ['', '   ', '...', '///', '-']) {
    assert.equal(suggestedFileName(empty, '.zmx'), 'system.zmx', JSON.stringify(empty));
  }
});

test('a very long name is trimmed, and never ends on a separator', () => {
  const name = suggestedFileName('word '.repeat(60), '.zmx');
  assert.ok(name.length <= 85, name.length.toString());
  assert.match(name, /^[^-].*[^-]\.zmx$/);
});
