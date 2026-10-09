import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertManualMutationAllowed, isAutopilotRunActive } from '../autopilot-engine.mjs';

const background = fs.readFileSync(path.join(import.meta.dirname, '..', 'background.js'), 'utf8');
const sidepanel = fs.readFileSync(path.join(import.meta.dirname, '..', 'sidepanel.js'), 'utf8');

test('only non-terminal autopilot states lock legacy mutations', () => {
  for (const state of ['READY', 'PLAN_REQUESTED', 'PLAN_RECEIVED', 'PLAN_VALIDATED', 'INJECTING', 'RUNNING', 'PAUSED']) {
    assert.equal(isAutopilotRunActive({ state }), true, state);
    assert.throws(() => assertManualMutationAllowed({ state }, 'edit'), /autopilot.*active/i, state);
  }
  for (const state of ['COMPLETE', 'FAILED', 'CANCELLED']) {
    assert.equal(isAutopilotRunActive({ state }), false, state);
    assert.doesNotThrow(() => assertManualMutationAllowed({ state }, 'edit'), state);
  }
});

test('background gates every legacy mutation entry point behind the autopilot lock', () => {
  assert.match(background, /function assertNoActiveAutopilot/);
  for (const command of [
    'NEW_MEETING',
    'ADD_PARTICIPANT',
    'REMOVE_PARTICIPANT',
    'BIND_PARTICIPANT',
    'START_MEETING',
    'PAUSE_MEETING',
    'RESUME_MEETING',
    'END_MEETING',
    'UPDATE_MEETING_SETTINGS',
    'UPDATE_PARTICIPANT_COORDINATION',
    'UPDATE_SESSION_TEMPLATE',
    'UPDATE_LOOP_GUARD',
    'CLEAR_TRANSCRIPT',
  ]) {
    assert.match(background, new RegExp(`case '${command}'[\\s\\S]{0,900}assertNoActiveAutopilot`), command);
  }
});

test('side panel disables legacy editing and destructive controls for an unfinished run', () => {
  assert.match(sidepanel, /function autopilotIsActive/);
  assert.match(sidepanel, /autopilotLocked/);
  assert.match(sidepanel, /els\.clearTranscript\.disabled/);
  assert.match(sidepanel, /els\.newMeeting\.disabled/);
});

