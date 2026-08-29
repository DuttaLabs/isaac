import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LAYOUT_2D,
  DEFAULT_RAY_FAN,
  DEFAULT_SPOT,
  defaultSettings,
  fieldShown,
  settingsOf,
  withFieldShown,
  type Layout2DSettings,
} from '../src/lib/panel-settings.ts';
import {
  DEFAULT_WORKSPACE,
  findPane,
  setPanePanel,
  setPaneSettings,
  splitPane,
} from '../src/lib/workspace.ts';

test('only output panels carry settings', () => {
  // Input panels read the design directly, so every copy shows the same thing
  // and there is nothing for a copy to hold of its own.
  assert.equal(defaultSettings('source'), undefined);
  assert.equal(defaultSettings('system'), undefined);
  assert.equal(defaultSettings('firstOrder'), undefined);
  assert.equal(defaultSettings('layout2d')?.panel, 'layout2d');
  assert.equal(defaultSettings('rayFan')?.panel, 'rayFan');
  assert.equal(defaultSettings('spot')?.panel, 'spot');
});

test('two copies of one panel keep separate settings', () => {
  // The property the whole change exists for: one Layout 2D on X–Z beside
  // another on Y–Z.
  const two = splitPane(DEFAULT_WORKSPACE, 'pane-layout-2d', 'row');
  const paired = setPanePanel(two, 'pane-1', 'layout2d');
  const changed = setPaneSettings(paired, 'pane-1', {
    ...DEFAULT_LAYOUT_2D,
    plane: 'XZ',
  });

  assert.equal(settingsOf(findPane(changed, 'pane-1')?.settings, DEFAULT_LAYOUT_2D).plane, 'XZ');
  assert.equal(
    settingsOf(findPane(changed, 'pane-layout-2d')?.settings, DEFAULT_LAYOUT_2D).plane,
    'YZ',
  );
});

test('turning a pane over to another panel leaves the old settings behind', () => {
  // They describe the panel that has gone. Carrying them across is how a
  // Layout 2D's plane ends up half-applied to a spot diagram.
  const turned = setPanePanel(
    setPaneSettings(DEFAULT_WORKSPACE, 'pane-layout-2d', {
      ...DEFAULT_LAYOUT_2D,
      plane: 'XY',
    }),
    'pane-layout-2d',
    'spot',
  );
  assert.deepEqual(findPane(turned, 'pane-layout-2d')?.settings, DEFAULT_SPOT);
});

test('settings are merged onto the defaults, never trusted whole', () => {
  // What makes a stored layout survive Isaac growing a setting: an older one
  // simply lacks the key and takes the default.
  const partial = { panel: 'layout2d', plane: 'XZ' } as unknown as Layout2DSettings;
  const read = settingsOf(partial, DEFAULT_LAYOUT_2D);
  assert.equal(read.plane, 'XZ');
  assert.equal(read.raysPerFan, DEFAULT_LAYOUT_2D.raysPerFan);
  assert.equal(read.quarterTurns, 0);

  // Settings belonging to a different panel say nothing about this one.
  assert.equal(settingsOf(DEFAULT_RAY_FAN, DEFAULT_LAYOUT_2D), DEFAULT_LAYOUT_2D);
  assert.equal(settingsOf(undefined, DEFAULT_LAYOUT_2D), DEFAULT_LAYOUT_2D);
});

test('a field list reads past its end as visible', () => {
  // A design gaining a field does not need every plot's list rewritten, and one
  // losing a field leaves no stale flags behind.
  assert.equal(fieldShown([], 0), true);
  assert.equal(fieldShown([false], 0), false);
  assert.equal(fieldShown([false], 3), true);

  // Padding fills with visible, so switching off field 2 does not switch on 0
  // and 1 — they were already on.
  assert.deepEqual(withFieldShown([], 2, false), [true, true, false]);
  assert.deepEqual(withFieldShown([false], 2, false), [false, true, false]);
  assert.deepEqual(withFieldShown([false, false], 0, true), [true, false]);
});
