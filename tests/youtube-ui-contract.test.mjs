import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

test('Side Panel presents the YouTube creator flow', async () => {
  const html = await read('sidepanel.html');
  for (const id of ['participants', 'composer', 'startMeeting', 'captureSummary', 'captureList', 'advancedPanel']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /새 쇼츠 장면/);
  assert.match(html, /장면 시작/);
  assert.match(html, /직접 진행/);
  assert.match(html, /자동 진행/);
  assert.doesNotMatch(html, /PARTICIPANTS|MEETING CONTROLS|SESSION TEMPLATE/);
});

test('technical controls are behind one collapsed entry point', async () => {
  const html = await read('sidepanel.html');
  assert.match(html, /<details[^>]+id=["']advancedPanel["']/);
  assert.doesNotMatch(html, /<details[^>]+id=["']advancedPanel["'][^>]*open/);
});

test('Side Panel uses capture jobs and simple open-file actions', async () => {
  const js = await read('sidepanel.js');
  assert.match(js, /LIST_SCREENSHOT_JOBS/);
  assert.match(js, /OPEN_SCREENSHOT/);
  assert.match(js, /buildYouTubeSurfaceModel/);
});

test('Side Panel exposes the keyword project planner and approval gate', async () => {
  const html = await read('sidepanel.html');
  for (const id of ['projectKeyword', 'buildProject', 'projectPlan', 'projectSummary', 'sceneList', 'projectApproval', 'approveProjectRun', 'sceneProgress']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /프로젝트 설계/);
  assert.match(html, /이 설계로 실행 승인/);
});

test('Side Panel wires project build, approval, and transition rendering', async () => {
  const js = await read('sidepanel.js');
  assert.match(js, /BUILD_PROJECT_PLAN/);
  assert.match(js, /APPROVE_PROJECT_RUN/);
  assert.match(js, /SCENE_TRANSITION/);
  assert.match(js, /projectPlan.*approval|approval.*projectPlan/s);
});
