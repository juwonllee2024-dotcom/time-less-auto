import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const backgroundSource = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');

test('background records project turns and creates a scene transition card', () => {
  assert.match(backgroundSource, /recordProjectTurn/);
  assert.match(backgroundSource, /buildSceneTransitionCard/);
  assert.match(backgroundSource, /kind:\s*['"]SCENE_TRANSITION['"]/);
});

test('transition card is saved before the next speaker is scheduled', () => {
  const transition = backgroundSource.indexOf("kind: 'SCENE_TRANSITION'");
  const save = backgroundSource.indexOf('await saveMeeting', transition);
  const schedule = backgroundSource.indexOf('scheduleSpeaker', save);

  assert.ok(transition >= 0, 'transition card insertion is missing');
  assert.ok(save > transition, 'transition card must be persisted before scheduling');
  assert.ok(schedule > save, 'next speaker must be scheduled after transition persistence');
});
