import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, N_BK7, OpticalSystem, Surface } from '@isaac/optical-core';
import {
  colorsInUse,
  hasChosenMirrorColor,
  mirrorColor,
  defaultGapColor,
  elementAt,
  elementColorsBySurface,
  elementLabel,
  elementRowSpan,
  findElements,
  gapColor,
  hasChosenColor,
  hasChosenEndColor,
  endColor,
  surfaceColorsBySurface,
  systemEnds,
  ELEMENT_PALETTE,
  IMAGE_END_COLOR,
  OBJECT_END_COLOR,
} from '../src/lib/elements.ts';
import { GLASS_CATALOG } from '../src/lib/materials.ts';
import { defaultSystem } from '../src/lib/default-system.ts';
import { removeSurface } from '../src/lib/edits.ts';

const F2 = GLASS_CATALOG.get('F2')!;

function system(...middle: Surface[]): OpticalSystem {
  return new OpticalSystem({
    name: 'test',
    wavelengthsNm: [587.5618],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      ...middle,
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });
}

const glassFace = (id: string, radius: number, thickness: number, material = N_BK7): Surface =>
  new Surface({ id, type: 'STANDARD', radius, thickness, semiDiameter: 10, material });

const airFace = (id: string, radius: number, thickness: number): Surface =>
  new Surface({ id, type: 'STANDARD', radius, thickness, semiDiameter: 10 });

test('a singlet is one element spanning its two faces', () => {
  const elements = findElements(system(glassFace('a', 50, 5), airFace('b', -50, 90)));

  assert.equal(elements.length, 1);
  assert.deepStrictEqual(
    { firstIndex: elements[0]!.firstIndex, lastIndex: elements[0]!.lastIndex },
    { firstIndex: 1, lastIndex: 2 },
  );
  assert.equal(elementRowSpan(elements[0]!), 2);
  assert.equal(elementLabel(elements[0]!, {}), 'L1');
});

test('two singlets are two elements, numbered in order', () => {
  const elements = findElements(
    system(
      glassFace('a', 50, 5),
      airFace('b', -50, 20),
      glassFace('c', 40, 4),
      airFace('d', -200, 60),
    ),
  );

  assert.deepStrictEqual(
    elements.map((e) => [e.firstIndex, e.lastIndex, elementLabel(e, {})]),
    [
      [1, 2, 'L1'],
      [3, 4, 'L2'],
    ],
  );
});

test('a cemented doublet is one element over three rows, not two fighting for the middle', () => {
  // Glass across both gaps: one piece of glass you can pick up, so one element.
  const elements = findElements(
    system(glassFace('a', 92, 6), glassFace('b', -30, 3, F2), airFace('c', -78, 90)),
  );

  assert.equal(elements.length, 1);
  assert.equal(elements[0]!.firstIndex, 1);
  assert.equal(elements[0]!.lastIndex, 3);
  assert.equal(elementRowSpan(elements[0]!), 3);
});

test('the sample doublet reads as one element', () => {
  const elements = findElements(defaultSystem());
  assert.equal(elements.length, 1);
  assert.equal(elementRowSpan(elements[0]!), 3);
});

test('air gaps and bare surfaces belong to no element', () => {
  const elements = findElements(
    system(airFace('a', Infinity, 10), glassFace('b', 50, 5), airFace('c', -50, 90)),
  );

  assert.equal(elements.length, 1);
  assert.equal(elementAt(elements, 1), undefined);
  assert.equal(elementAt(elements, 2)?.firstIndex, 2);
  assert.equal(elementAt(elements, 3)?.firstIndex, 2);
  assert.equal(elementAt(elements, 4), undefined); // the image surface
});

const mirrorFace = (id: string, radius: number, thickness: number): Surface =>
  new Surface({ id, type: 'STANDARD', radius, thickness, semiDiameter: 20, reflective: true });

test('a mirror in air is an element of its own, one surface wide', () => {
  const [element, ...rest] = findElements(system(mirrorFace('m', -200, -90)));
  assert.equal(rest.length, 0);
  assert.equal(element?.kind, 'MIRROR');
  // One row, and no glass in it: there is no body to fill, so no gaps.
  assert.equal(element?.firstIndex, 1);
  assert.equal(element?.lastIndex, 1);
  assert.equal(elementRowSpan(element!), 1);
  assert.deepEqual(element?.gaps, []);
  assert.equal(elementLabel(element!, {}), 'M1');
});

test('a transform between the faces does not break the element in two', () => {
  // A tilted rear face is written exactly this way, and a transform carries the
  // medium before it -- so left in the walk it would look like glass continuing.
  const elements = findElements(
    system(
      glassFace('a', 50, 5),
      new Surface({
        id: 'tilt',
        type: 'COORDINATE_TRANSFORM',
        thickness: 0,
        // A transform cannot be a boundary between media; the model insists.
        material: N_BK7,
        coordinateTransform: {
          decenterX: 0,
          decenterY: 0,
          tiltXDeg: 3,
          tiltYDeg: 0,
          tiltZDeg: 0,
          tiltFirst: false,
        },
      }),
      airFace('b', -50, 90),
    ),
  );

  assert.equal(elements.length, 1);
  assert.equal(elements[0]!.firstIndex, 1);
  assert.equal(elements[0]!.lastIndex, 3, 'the span covers the transform row between the faces');
  assert.equal(elementRowSpan(elements[0]!), 3);
});

test('an element is keyed by its front surface, so edits do not move a label', () => {
  const before = system(glassFace('a', 50, 5), airFace('b', -50, 90));
  const [element] = findElements(before);
  assert.equal(element!.key, 'a');

  // A thickness edit, then an inserted surface ahead of it: the key holds.
  const after = before.withSurfaceAt(1, before.surfaceAt(1).with({ thickness: 7 })).with({
    surfaces: [before.surfaceAt(0), airFace('new', Infinity, 5), ...before.surfaces.slice(1)],
  });
  const [moved] = findElements(after);
  assert.equal(moved!.key, 'a');
  assert.equal(moved!.firstIndex, 2, 'it did move down a row');
  assert.equal(elementLabel(moved!, { a: { label: 'Front doublet' } }), 'Front doublet');
});

test('a custom label wins, and a blank one falls back to L#', () => {
  const [element] = findElements(system(glassFace('a', 50, 5), airFace('b', -50, 90)));
  assert.equal(elementLabel(element!, { a: { label: 'Objective' } }), 'Objective');
  assert.equal(elementLabel(element!, { a: { label: '   ' } }), 'L1');
  assert.equal(elementLabel(element!, {}), 'L1');
});

test('a cemented doublet is one element with two pieces of glass', () => {
  const cemented = system(glassFace('a', 92, 6), glassFace('b', -30, 3, F2), airFace('c', -78, 90));
  const [element] = findElements(cemented);

  assert.equal(element!.gaps.length, 2, 'two glasses, so two things to color');
  assert.deepStrictEqual(
    element!.gaps.map((gap) => [gap.frontIndex, gap.backIndex]),
    [
      [1, 2],
      [2, 3],
    ],
  );
  // Both views identify a body by its front surface, so the keys have to differ
  // or the two halves could never be told apart.
  assert.notEqual(element!.gaps[0]!.key, element!.gaps[1]!.key);
});

test('every piece of glass starts with its own default color', () => {
  const two = system(
    glassFace('a', 92, 6),
    glassFace('b', -30, 3, F2),
    airFace('c', -78, 20),
    glassFace('d', 40, 4),
    airFace('e', -200, 60),
  );
  const gaps = findElements(two).flatMap((element) => element.gaps);

  assert.equal(gaps.length, 3, 'a doublet and a singlet');
  const colors = gaps.map((gap) => gapColor(gap, {}));
  assert.equal(new Set(colors).size, 3, 'no two pieces of glass open the same color');
  assert.deepStrictEqual(colors, ELEMENT_PALETTE.slice(0, 3));
  for (const gap of gaps) {
    assert.equal(hasChosenColor(gap, {}), false);
    assert.equal(gapColor(gap, {}), defaultGapColor(gap));
  }
});

test('a chosen color wins over the default, and can be dropped again', () => {
  const [element] = findElements(system(glassFace('a', 50, 5), airFace('b', -50, 90)));
  const gap = element!.gaps[0]!;

  assert.equal(gapColor(gap, { a: { color: '#ff0000' } }), '#ff0000');
  assert.equal(hasChosenColor(gap, { a: { color: '#ff0000' } }), true);
  assert.equal(gapColor(gap, { a: { label: 'Objective' } }), defaultGapColor(gap));
});

test('the two halves of a doublet can be colored apart', () => {
  const cemented = system(glassFace('a', 92, 6), glassFace('b', -30, 3, F2), airFace('c', -78, 90));
  const colors = elementColorsBySurface(cemented, {
    a: { color: '#ff0000' },
    b: { color: '#0000ff' },
  });

  assert.equal(colors.get(1), '#ff0000');
  assert.equal(colors.get(2), '#0000ff');
  assert.equal(colors.get(3), undefined, 'surface 3 begins no glass');
});

test('with nothing chosen, both views still get a color for every body', () => {
  const cemented = system(glassFace('a', 92, 6), glassFace('b', -30, 3, F2), airFace('c', -78, 90));
  const colors = elementColorsBySurface(cemented, {});

  assert.equal(colors.size, 2);
  assert.notEqual(colors.get(1), colors.get(2));
});

test('the colors on offer for reuse are the ones actually on screen', () => {
  const cemented = system(glassFace('a', 92, 6), glassFace('b', -30, 3, F2), airFace('c', -78, 90));
  const elements = findElements(cemented);

  // Defaults count: they are what is drawn, which is what makes the row useful.
  assert.deepStrictEqual(colorsInUse(elements, {}), ELEMENT_PALETTE.slice(0, 2));
  assert.deepStrictEqual(
    colorsInUse(elements, { a: { color: '#123456' }, b: { color: '#123456' } }),
    ['#123456'],
  );
});

test('the ends of the system are the object and image surfaces', () => {
  const doublet = system(glassFace('a', 100, 6), glassFace('b', -50, 3, F2), airFace('c', -80, 90));
  const ends = systemEnds(doublet);
  assert.equal(ends.length, 2);
  assert.deepEqual(
    ends.map((end) => [end.index, end.key, end.label]),
    [
      [0, 'obj', 'OBJ'],
      [4, 'img', 'IMG'],
    ],
  );
});

test('an end key can never collide with a piece of glass', () => {
  // The walk starts past the object, and the last surface can only ever be a
  // gap's back face — so neither end's id is ever a gap key, which is what lets
  // both share one `ElementStyles` map.
  const doublet = system(glassFace('a', 100, 6), glassFace('b', -50, 3, F2), airFace('c', -80, 90));
  const gapKeys = new Set(findElements(doublet).flatMap((el) => el.gaps.map((gap) => gap.key)));
  for (const end of systemEnds(doublet)) {
    assert.ok(!gapKeys.has(end.key), `${end.label} collided with a gap`);
  }
});

test('the ends start with their own colors, outside the glass palette', () => {
  const ends = systemEnds(system(airFace('a', 100, 90)));
  assert.equal(endColor(ends[0]!, {}), OBJECT_END_COLOR);
  assert.equal(endColor(ends[1]!, {}), IMAGE_END_COLOR);
  for (const end of ends) {
    assert.ok(
      !ELEMENT_PALETTE.includes(end.defaultColor),
      'an end is not glass and should not wear a glass color',
    );
  }
  assert.notEqual(OBJECT_END_COLOR, IMAGE_END_COLOR);
});

test('a chosen end color wins, and says it was chosen', () => {
  const ends = systemEnds(system(airFace('a', 100, 90)));
  const image = ends[1]!;
  assert.equal(hasChosenEndColor(image, {}), false);
  const styles = { [image.key]: { color: '#ff0000' } };
  assert.equal(endColor(image, styles), '#ff0000');
  assert.equal(hasChosenEndColor(image, styles), true);
  // The other end is untouched.
  assert.equal(endColor(ends[0]!, styles), OBJECT_END_COLOR);
});

test('end colors are keyed by surface index, for the views', () => {
  const lens = system(glassFace('a', 100, 6), airFace('b', -80, 90));
  const colors = surfaceColorsBySurface(lens, {});
  assert.deepEqual(
    [...colors.keys()].sort((x, y) => x - y),
    [0, 3],
  );
  assert.equal(colors.get(3), IMAGE_END_COLOR);
});

test('colors already in the design include the ends when asked', () => {
  const lens = system(glassFace('a', 100, 6), airFace('b', -80, 90));
  const elements = findElements(lens);
  const withoutEnds = colorsInUse(elements, {});
  const withEnds = colorsInUse(elements, {}, systemEnds(lens));
  assert.ok(!withoutEnds.includes(IMAGE_END_COLOR.toLowerCase()));
  assert.ok(withEnds.includes(IMAGE_END_COLOR.toLowerCase()));
  assert.ok(withEnds.includes(OBJECT_END_COLOR.toLowerCase()));
});

/*
 * What deleting a surface does to the element it belonged to.
 *
 * Nothing tells `findElements` about the delete, and nothing needs to: an
 * element is a run of glass between two faces, so removing a face re-reads as
 * whatever run is left. These pin the three outcomes, because the whole point of
 * deriving elements is that the answer is never stored anywhere to go stale.
 */

/** Crown, cemented interface, flint, then air: one element spanning three rows. */
function doublet(): OpticalSystem {
  return system(glassFace('s1', 60, 6, N_BK7), glassFace('s2', -40, 4, F2), airFace('s3', -90, 90));
}

test('a doublet is one element over three rows before anything is deleted', () => {
  const [element, ...rest] = findElements(doublet());
  assert.equal(rest.length, 0);
  assert.equal(element?.gaps.length, 2);
  assert.equal(elementRowSpan(element!), 3);
});

test('deleting the cemented interface leaves a singlet, not half a doublet', () => {
  const result = removeSurface(doublet(), 2);
  assert.ok(result.ok);
  const [element, ...rest] = findElements(result.value);
  assert.equal(rest.length, 0);
  // One piece of glass across one gap: the crown now runs to what was the rear
  // face. The element survives, smaller, and keeps its key — so the name and the
  // color the user gave it stay with it.
  assert.equal(element?.gaps.length, 1);
  assert.equal(elementRowSpan(element!), 2);
  assert.equal(element?.key, 's1');
});

test('deleting the face the glass begins at leaves no element at all', () => {
  const result = removeSurface(doublet(), 1);
  assert.ok(result.ok);
  const [element, ...rest] = findElements(result.value);
  assert.equal(rest.length, 0);
  // The flint still starts somewhere, so there is still an element — this is the
  // *front* face going, and the run that is left is the flint half.
  assert.equal(element?.key, 's2');
  assert.equal(element?.gaps.length, 1);

  // Take that one too and there is no glass left to imply anything: two air
  // surfaces and no element, which is a surface and nothing more.
  const bare = removeSurface(result.value, 1);
  assert.ok(bare.ok);
  assert.deepEqual(findElements(bare.value), []);
});

test('an element deleted out of the middle renumbers the ones behind it', () => {
  const two = system(
    glassFace('a1', 60, 6, N_BK7),
    airFace('a2', -60, 20),
    glassFace('b1', 80, 6, F2),
    airFace('b2', -80, 90),
  );
  assert.deepEqual(
    findElements(two).map((element) => [element.key, element.ordinal, element.gaps[0]?.colorIndex]),
    [
      ['a1', 1, 0],
      ['b1', 2, 1],
    ],
  );

  // The first element's glass goes, so the second becomes the first — and takes
  // the first default color with it. Only a *chosen* color survives a delete
  // ahead of it, which is what choosing one is for.
  const result = removeSurface(two, 1);
  assert.ok(result.ok);
  assert.deepEqual(
    findElements(result.value).map((element) => [
      element.key,
      element.ordinal,
      element.gaps[0]?.colorIndex,
    ]),
    [['b1', 1, 0]],
  );
});

test('lenses and mirrors are numbered apart', () => {
  const elements = findElements(
    system(
      glassFace('l1a', 100, 6),
      airFace('l1b', -100, 40),
      mirrorFace('m1', -300, -40),
      glassFace('l2a', -80, -6, F2),
      airFace('l2b', 80, -40),
      mirrorFace('m2', 300, 60),
    ),
  );
  assert.deepEqual(
    elements.map((element) => [element.kind, elementLabel(element, {})]),
    [
      ['LENS', 'L1'],
      ['MIRROR', 'M1'],
      ['LENS', 'L2'],
      ['MIRROR', 'M2'],
    ],
  );
});

test('a mirror inside glass stays part of the solid it is the back of', () => {
  // A Mangin mirror: glass across the front gap, a silvered rear face, and the
  // light back out through the same glass. One piece to hold, so one element.
  const mangin = system(
    glassFace('front', 100, 8),
    new Surface({
      id: 'back',
      type: 'STANDARD',
      radius: -120,
      thickness: -8,
      semiDiameter: 20,
      reflective: true,
      material: N_BK7,
    }),
    airFace('out', 100, -60),
  );
  const [element, ...rest] = findElements(mangin);
  assert.equal(rest.length, 0);
  assert.equal(element?.kind, 'LENS');
  assert.equal(elementLabel(element!, {}), 'L1');
});

test('a mirror takes no palette slot, so adding one repaints no lens', () => {
  const withoutMirror = system(glassFace('a', 100, 6), airFace('b', -80, 90));
  const withMirror = system(
    mirrorFace('m', -300, 40),
    glassFace('a', 100, 6),
    airFace('b', -80, 90),
  );
  const colorOf = (found: ReturnType<typeof findElements>): string | undefined => {
    const lens = found.find((element) => element.kind === 'LENS');
    return lens?.gaps[0] === undefined ? undefined : defaultGapColor(lens.gaps[0]);
  };
  assert.equal(colorOf(findElements(withMirror)), colorOf(findElements(withoutMirror)));
  assert.equal(colorOf(findElements(withoutMirror)), ELEMENT_PALETTE[0]);
});

test("a mirror's default color is the theme's, and only a chosen one reaches the views", () => {
  const folded = system(mirrorFace('m', -300, 40), glassFace('a', 100, 6), airFace('b', -80, 90));
  const [mirror] = findElements(folded);
  assert.equal(mirror?.kind, 'MIRROR');
  assert.equal(mirrorColor(mirror!, {}, '#9fb4c4'), '#9fb4c4');
  assert.equal(hasChosenMirrorColor(mirror!, {}), false);

  // Untouched, it is absent from the map: the views resolve the theme token
  // themselves, and a value here would freeze it to one theme.
  assert.equal(surfaceColorsBySurface(folded, {}).has(1), false);

  const styles = { [mirror!.key]: { color: '#ff8800' } };
  assert.equal(mirrorColor(mirror!, styles, '#9fb4c4'), '#ff8800');
  assert.equal(hasChosenMirrorColor(mirror!, styles), true);
  assert.equal(surfaceColorsBySurface(folded, styles).get(1), '#ff8800');
});

test("a mirror's key can never be claimed by a gap or by an end", () => {
  const folded = system(mirrorFace('m', -300, 40), glassFace('a', 100, 6), airFace('b', -80, 90));
  const elements = findElements(folded);
  const mirror = elements.find((element) => element.kind === 'MIRROR')!;
  const gapKeys = elements.flatMap((element) => element.gaps.map((gap) => gap.key));
  const endKeys = systemEnds(folded).map((end) => end.key);
  // A gap's key is the id of a surface with glass after it, and a bare mirror has
  // air after it; the ends are the object and image planes, which cannot reflect.
  assert.ok(!gapKeys.includes(mirror.key));
  assert.ok(!endKeys.includes(mirror.key));
});

test('a colored mirror is offered for reuse, but only with a theme to read', () => {
  const folded = system(mirrorFace('m', -300, 40), glassFace('a', 100, 6), airFace('b', -80, 90));
  const elements = findElements(folded);
  assert.ok(colorsInUse(elements, {}, [], '#9fb4c4').includes('#9fb4c4'));
  assert.ok(!colorsInUse(elements, {}, []).includes('#9fb4c4'));
});
