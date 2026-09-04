/**
 * What the assistant proposes, and what happens when it is wrong.
 *
 * The interesting cases here are all failures. A proposal that is correct
 * applies through `edits.ts` like any other edit and is already covered by
 * `edits.test.ts`; what is new is that the *source* of these edits is a model,
 * so the tests are about a proposal that names a surface which does not exist,
 * a glass nobody makes, or a number that is not a number — and about the answer
 * being a sentence rather than a broken design.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultSystem } from '../src/lib/default-system.ts';
import { applyEdits, previewEdits } from '../src/lib/help-actions.ts';
import { readAction, type ProposedEdit } from '../src/lib/help.ts';

const system = defaultSystem();

test('a preview shows what is there now beside what it would become', () => {
  const [row] = previewEdits(system, [{ surface: 1, property: 'thickness', value: '8' }]);
  assert.equal(row?.surface, 1);
  assert.equal(row?.label, 'Thickness');
  assert.equal(row?.before, '6');
  assert.equal(row?.after, '8');
  assert.equal(row?.problem, undefined);
});

test('an impossible row is shown with its reason, never dropped', () => {
  // Dropping it would leave a list that cannot be checked against what the
  // assistant said it was going to do, which is the whole job of the preview.
  const rows = previewEdits(system, [
    { surface: 1, property: 'thickness', value: '8' },
    { surface: 99, property: 'radius', value: '50' },
    { surface: 2, property: 'material', value: 'UNOBTAINIUM' },
    { surface: 1, property: 'radius', value: 'about ninety' },
  ]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0]?.problem, undefined);
  assert.match(rows[1]?.problem ?? '', /no surface 99/);
  assert.match(rows[2]?.problem ?? '', /UNOBTAINIUM/);
  assert.match(rows[3]?.problem ?? '', /not a number/);
});

test('a mirror says the second thing it moves, as a note and not a problem', () => {
  const [row] = previewEdits(system, [{ surface: 2, property: 'mirror', value: 'true' }]);
  assert.equal(row?.problem, undefined, 'making a mirror is possible');
  // The thickness after it flips sign, and a user who is not told that will
  // find the rest of their design somewhere the light no longer goes.
  assert.match(row?.note ?? '', /thickness/);
});

test('Infinity is a radius a person may propose', () => {
  const [row] = previewEdits(system, [{ surface: 1, property: 'radius', value: 'Infinity' }]);
  assert.equal(row?.after, 'Infinity');
  const applied = applyEdits(system, [{ surface: 1, property: 'radius', value: 'Infinity' }]);
  assert.ok(applied.ok);
  assert.equal(applied.value.surfaceAt(1).radius, Infinity);
});

test('edits apply together', () => {
  const edits: ProposedEdit[] = [
    { surface: 1, property: 'thickness', value: '8' },
    { surface: 2, property: 'material', value: 'N-SF6' },
  ];
  const applied = applyEdits(system, edits);
  assert.ok(applied.ok);
  assert.equal(applied.value.surfaceAt(1).thickness, 8);
  assert.match(applied.value.surfaceAt(2).material.name, /SF6/i);
});

test('one bad edit applies none of them', () => {
  // A half-applied proposal is the worst outcome available: the design is then
  // in a state nobody described, and one undo entry puts back only part of it.
  const applied = applyEdits(system, [
    { surface: 1, property: 'thickness', value: '8' },
    { surface: 42, property: 'radius', value: '10' },
  ]);
  assert.equal(applied.ok, false);
  assert.equal(system.surfaceAt(1).thickness, 6, 'the original is untouched');
});

test('an engine refusal comes back in the engine\'s own words', () => {
  // The image surface cannot reflect, and the message should say why rather
  // than being flattened into "that did not work".
  const applied = applyEdits(system, [
    { surface: system.surfaces.length - 1, property: 'mirror', value: 'true' },
  ]);
  assert.equal(applied.ok, false);
  assert.match(applied.ok ? '' : applied.error, /image|record rays/i);
});

test('an action that does not read cleanly is dropped, not guessed at', () => {
  assert.equal(readAction(undefined), undefined);
  assert.equal(readAction({ kind: 'nonsense' }), undefined);
  assert.equal(readAction({ kind: 'highlight_surface' }), undefined);
  assert.equal(readAction({ kind: 'highlight_surface', surface: 'two' }), undefined);
  assert.equal(readAction({ kind: 'load_design', zmx: 'VERS 1' }), undefined, 'needs a name too');
  assert.equal(readAction({ kind: 'propose_edits', edits: [] }), undefined, 'an empty proposal is none');
  assert.equal(
    readAction({ kind: 'propose_edits', edits: [{ surface: 1, property: 'colour', value: 'red' }] }),
    undefined,
    'a property the app cannot perform',
  );
});

test('a well-formed action reads back exactly', () => {
  assert.deepEqual(readAction({ kind: 'highlight_surface', surface: 2 }), {
    kind: 'highlight_surface',
    surface: 2,
  });
  const proposal = readAction({
    kind: 'propose_edits',
    why: 'flatten the rear face',
    edits: [{ surface: 3, property: 'radius', value: 'Infinity' }],
  });
  assert.equal(proposal?.kind, 'propose_edits');
});
