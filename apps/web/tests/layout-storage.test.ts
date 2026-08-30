import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LIBRARY,
  readLibrary,
  serializeLibrary,
  withWorkspace,
  workspaceIn,
} from '../src/lib/layout-storage.ts';
import { DEFAULT_LAYOUT_2D, settingsOf } from '../src/lib/panel-settings.ts';
import {
  DEFAULT_WORKSPACE,
  MINIMUM_RATIO,
  findPane,
  panesInOrder,
  setPaneSettings,
  splitPane,
  type Workspace,
} from '../src/lib/workspace.ts';

const shape = (workspace: Workspace): unknown =>
  panesInOrder(workspace).map((pane) => [pane.key, pane.panel]);

test('an arrangement survives a round trip exactly', () => {
  // The property the whole feature rests on: a Workspace is plain data, so
  // JSON is lossless on it. (It is not on OpticalSystem, whose class instances
  // would come back as bare numbers.)
  const arranged = setPaneSettings(
    splitPane(DEFAULT_WORKSPACE, 'pane-layout-2d', 'column'),
    'pane-layout-2d',
    { ...DEFAULT_LAYOUT_2D, plane: 'XZ', quarterTurns: 1, raysPerFan: 15 },
  );
  const library = withWorkspace(DEFAULT_LIBRARY, 'layout-main', arranged);
  const back = readLibrary(serializeLibrary(library));

  assert.deepEqual(back, library);
  const restored = workspaceIn(back, 'layout-main', DEFAULT_WORKSPACE);
  const settings = settingsOf(findPane(restored, 'pane-layout-2d')?.settings, DEFAULT_LAYOUT_2D);
  assert.equal(settings.plane, 'XZ');
  assert.equal(settings.quarterTurns, 1);
  assert.equal(settings.raysPerFan, 15);
});

test('nothing stored, or nonsense stored, opens the default arrangement', () => {
  assert.deepEqual(readLibrary(null), DEFAULT_LIBRARY);
  assert.deepEqual(readLibrary(''), DEFAULT_LIBRARY);
  assert.deepEqual(readLibrary('{not json'), DEFAULT_LIBRARY);
  assert.deepEqual(readLibrary('42'), DEFAULT_LIBRARY);
  assert.deepEqual(readLibrary('{"layouts":[]}'), DEFAULT_LIBRARY);
  // A future format is a different version and is not guessed at.
  assert.deepEqual(readLibrary('{"version":99,"layouts":[]}'), DEFAULT_LIBRARY);
});

test('a layout written by an older Isaac keeps its shape and loses only what is gone', () => {
  // The failure this exists to prevent: a stored tree naming a panel this build
  // does not have. Blanking that one pane keeps the arrangement someone built.
  const stored = JSON.stringify({
    version: 1,
    layouts: [
      {
        key: 'layout-main',
        name: 'Design',
        workspace: {
          nextKey: 1,
          root: {
            kind: 'split',
            key: 'split-1',
            direction: 'row',
            ratio: 0.4,
            first: { kind: 'pane', key: 'pane-1', panel: 'system' },
            second: { kind: 'pane', key: 'pane-2', panel: 'wavefrontMap' },
          },
        },
      },
    ],
    main: 'layout-main',
    secondary: 'layout-main',
    nextKey: 1,
  });

  const workspace = workspaceIn(readLibrary(stored), 'layout-main', DEFAULT_WORKSPACE);
  assert.deepEqual(shape(workspace), [
    ['pane-1', 'system'],
    ['pane-2', undefined],
  ]);
});

test('a bad value is repaired rather than costing the whole layout', () => {
  const withRatio = (ratio: unknown): number => {
    const stored = JSON.stringify({
      version: 1,
      layouts: [
        {
          key: 'a',
          name: 'A',
          workspace: {
            nextKey: 1,
            root: {
              kind: 'split',
              key: 's',
              direction: 'row',
              ratio,
              first: { kind: 'pane', key: 'p1', panel: 'system' },
              second: { kind: 'pane', key: 'p2', panel: 'source' },
            },
          },
        },
      ],
      main: 'a',
      secondary: 'a',
      nextKey: 1,
    });
    const root = workspaceIn(readLibrary(stored), 'a', DEFAULT_WORKSPACE).root;
    assert.equal(root.kind, 'split');
    return root.kind === 'split' ? root.ratio : Number.NaN;
  };

  assert.equal(withRatio(0.4), 0.4);
  assert.equal(withRatio(9), 1 - MINIMUM_RATIO);
  assert.equal(withRatio(-3), MINIMUM_RATIO);
  assert.equal(withRatio('half'), 0.5);
  assert.equal(withRatio(null), 0.5);
});

test('duplicate pane keys drop the layout, because they cannot be repaired', () => {
  // React identifies a pane by its key, and every workspace operation names one.
  // Two panes claiming a key would silently become one.
  const stored = JSON.stringify({
    version: 1,
    layouts: [
      {
        key: 'a',
        name: 'A',
        workspace: {
          nextKey: 1,
          root: {
            kind: 'split',
            key: 's',
            direction: 'row',
            ratio: 0.5,
            first: { kind: 'pane', key: 'same', panel: 'system' },
            second: { kind: 'pane', key: 'same', panel: 'source' },
          },
        },
      },
    ],
    main: 'a',
    secondary: 'a',
    nextKey: 1,
  });
  assert.deepEqual(readLibrary(stored), DEFAULT_LIBRARY);
});

test('the key counter is recomputed, so it can never mint one already in use', () => {
  // A stored counter that is too low hands out a duplicate — the one thing the
  // reader cannot repair — so the keys present are what it is taken from.
  const stored = JSON.stringify({
    version: 1,
    layouts: [
      {
        key: 'a',
        name: 'A',
        workspace: {
          nextKey: 1,
          root: {
            kind: 'split',
            key: 'split-9',
            direction: 'row',
            ratio: 0.5,
            first: { kind: 'pane', key: 'pane-12', panel: 'system' },
            second: { kind: 'pane', key: 'pane-3', panel: 'source' },
          },
        },
      },
    ],
    main: 'a',
    secondary: 'a',
    nextKey: 1,
  });
  assert.equal(workspaceIn(readLibrary(stored), 'a', DEFAULT_WORKSPACE).nextKey, 13);
});

test('a stored setting of the wrong type never reaches a trace', () => {
  const stored = JSON.stringify({
    version: 1,
    layouts: [
      {
        key: 'a',
        name: 'A',
        workspace: {
          nextKey: 1,
          root: {
            kind: 'pane',
            key: 'p',
            panel: 'layout2d',
            settings: {
              panel: 'layout2d',
              plane: 'XZ',
              raysPerFan: 'banana',
              fields: [true, 'yes'],
              showFirstOrder: true,
            },
          },
        },
      },
    ],
    main: 'a',
    secondary: 'a',
    nextKey: 1,
  });
  const pane = findPane(workspaceIn(readLibrary(stored), 'a', DEFAULT_WORKSPACE), 'p');
  const settings = settingsOf(pane?.settings, DEFAULT_LAYOUT_2D);

  assert.equal(settings.plane, 'XZ', 'a good value is kept');
  assert.equal(settings.showFirstOrder, true);
  assert.equal(settings.raysPerFan, DEFAULT_LAYOUT_2D.raysPerFan, 'a bad one takes the default');
  assert.deepEqual(settings.fields, [], 'a part-bad list is dropped whole');
});

test('a window pointing at a layout that is gone still has something to show', () => {
  const stored = JSON.stringify({
    version: 1,
    layouts: [{ key: 'a', name: 'A', workspace: DEFAULT_WORKSPACE }],
    main: 'a',
    secondary: 'deleted',
    nextKey: 1,
  });
  const library = readLibrary(stored);
  assert.equal(library.main, 'a');
  assert.equal(library.secondary, 'a');
});
