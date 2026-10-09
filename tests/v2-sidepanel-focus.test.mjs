import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');
const read = (name) => fs.readFile(path.join(root, name), 'utf8');

test('side panel has a focused three-step workspace without removing the full feature surface', async () => {
  const html = await read('sidepanel.html');
  for (const id of ['progressRail', 'focusCard', 'designWorkspace', 'conversationWorkspace', 'outputWorkspace']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} should be present`);
  }
  assert.match(html, /data-step=["']design["']/);
  assert.match(html, /data-step=["']run["']/);
  assert.match(html, /data-step=["']output["']/);
  for (const id of ['advancedPanel', 'activityPanel', 'participants', 'captureList', 'autopilotTimeline']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} must remain available`);
  }
});

test('side panel computes a single focused phase and exposes it to CSS', async () => {
  const js = await read('sidepanel.js');
  assert.match(js, /function renderFocusState\(model\)/);
  assert.match(js, /data-ui-phase/);
  assert.match(js, /design|run|output/);
  assert.match(js, /focusCard/);
});

test('focused UI styles keep advanced controls progressive and primary action prominent', async () => {
  const css = await read('sidepanel.css');
  assert.match(css, /\.progress-rail/);
  assert.match(css, /\.focus-card/);
  assert.match(css, /\.workspace-card/);
  assert.match(css, /\.advanced-panel/);
  assert.match(css, /\.app-shell\[data-ui-phase=/);
});
