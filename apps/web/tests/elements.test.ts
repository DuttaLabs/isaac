import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, N_BK7, OpticalSystem, Surface } from '@isaac/optical-core';
import {
  colorsInUse,
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
  endColorsBySurface,
  systemEnds,
  ELEMENT_PALETTE,
  IMAGE_END_COLOR,
  OBJECT_END_COLOR,
} from '../src/lib/elements.ts';
import { GLASS_CATALOG } from '../src/lib/materials.ts';
import { defaultSystem } from '../src/lib/default-system.ts';

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

test('a mirror in air is not an element', () => {
  // Its material is the medium before it, which is air; nothing solid here.
  const elements = findElements(
    system(
      new Surface({
        id: 'm',
        type: 'STANDARD',
        radius: -200,
        thickness: -90,
        semiDiameter: 20,
        reflective: true,
      }),
    ),
  );
  assert.deepStrictEqual(elements, []);
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
  const colors = endColorsBySurface(lens, {});
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
