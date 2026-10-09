import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

test('V2 control tower exposes planner, phase, provider, and artifact surfaces', async () => {
  const html = await read('sidepanel.html');
  for (const id of ['plannerTab', 'startAutopilot', 'pauseAutopilot', 'stopAutopilot', 'autopilotPhase', 'autopilotTimeline', 'autopilotProviders', 'artifactCard']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('V2 control tower starts keyword-only and can pause/resume/stop', async () => {
  const js = await read('sidepanel.js');
  assert.match(js, /START_AUTOPILOT/);
  assert.match(js, /autoProvision:\s*true/);
  assert.match(js, /PAUSE_AUTOPILOT/);
  assert.match(js, /RESUME_AUTOPILOT/);
  assert.match(js, /STOP_AUTOPILOT/);
  assert.match(js, /planHash/);
  assert.match(js, /ZIP/);
});

test('V2 control tower exposes a reset path after a stopped run', async () => {
  const html = await read('sidepanel.html');
  const js = await read('sidepanel.js');
  assert.match(html, /id=["']resetAutopilot["']/);
  assert.match(js, /RESET_AUTOPILOT/);
  assert.match(js, /canReset/);
});
