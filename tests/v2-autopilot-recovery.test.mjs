import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

test('planner continuation re-reads the run after the web AI await', () => {
  const start = background.indexOf('async function resolveAutopilotPlan');
  const end = background.indexOf('async function recoverAutopilotPlan', start);
  assert.ok(start >= 0 && end > start);
  const handler = background.slice(start, end);
  const wait = handler.indexOf('response = await waitForPlanResponse');
  assert.ok(wait >= 0);
  const continuation = handler.slice(wait);
  assert.match(continuation, /meeting = await getMeeting\(\)/);
  assert.match(continuation, /\['PAUSED',\s*'CANCELLED',\s*'FAILED',\s*'COMPLETE'\]/);
});

test('packaging does not mark a run complete before the ZIP download is verified', () => {
  const start = background.indexOf('async function packageAutopilotRun');
  const end = background.indexOf('async function finalizeAutopilotResponse', start);
  assert.ok(start >= 0 && end > start);
  const handler = background.slice(start, end);
  const verified = handler.indexOf('await waitForDownloadComplete(downloadId)');
  const persistedComplete = handler.indexOf("projectPlan: normalizeProjectPlan({ ...plan, status: 'COMPLETE' })");
  assert.ok(verified >= 0 && persistedComplete >= 0);
  assert.ok(verified < persistedComplete, 'persisted completion must follow download verification');
});

test('failed autopilot steps expose an explicit retry command and UI affordance', () => {
  assert.match(background, /case 'RETRY_AUTOPILOT'/);
  assert.match(background, /async function retryAutopilot/);
  const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8');
  assert.match(html, /id=["']retryAutopilot["']/);
  assert.match(js, /RETRY_AUTOPILOT/);
  assert.match(js, /canRetry/);
});

test('resume reconciles a paused meeting whose run state survived as active', () => {
  const start = background.indexOf('async function resumeAutopilot');
  const end = background.indexOf('async function stopAutopilot', start);
  assert.ok(start >= 0 && end > start);
  const handler = background.slice(start, end);
  assert.match(handler, /meeting\.status === 'PAUSED'/);
  assert.match(handler, /transitionAutopilot\(run, 'PAUSED'/);
  assert.match(handler, /pausedFrom: run\.pausedFrom \|\| persistedState/);
});

test('focus resume uses the persisted meeting pause state as the source of truth', () => {
  const sidepanel = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8');
  const start = sidepanel.indexOf("els.pauseAutopilot?.addEventListener");
  const end = sidepanel.indexOf("els.retryAutopilot?.addEventListener", start);
  assert.ok(start >= 0 && end > start);
  const handler = sidepanel.slice(start, end);
  assert.match(handler, /meeting\?\.status === 'PAUSED'/);
});

test('autopilot control label follows the persisted pause state', () => {
  const sidepanel = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8');
  const start = sidepanel.indexOf('function renderAutopilot');
  const end = sidepanel.indexOf('function renderProject', start);
  assert.ok(start >= 0 && end > start);
  const handler = sidepanel.slice(start, end);
  assert.match(handler, /const meetingIsPaused = meeting\?\.status === 'PAUSED'/);
  assert.match(handler, /const canResume = meetingIsPaused \|\|/);
  assert.match(handler, /els\.pauseAutopilot\.textContent = canResume/);
});

test('capture failures retain enough context for a step-only retry', () => {
  const start = background.indexOf('async function finalizeAutopilotResponse');
  const end = background.indexOf('async function completeResponse', start);
  assert.ok(start >= 0 && end > start);
  const handler = background.slice(start, end);
  const failure = handler.indexOf("status: 'failed'");
  assert.ok(failure >= 0);
  assert.match(handler.slice(failure), /pendingCapture/);
  assert.match(handler.slice(failure), /captureKey/);
});

test('a terminal autopilot run cannot hijack a later manual response', () => {
  assert.match(background, /if\s*\(isAutopilotRunActive\(autopilotRunFor\(meeting\)\)\)\s*return finalizeAutopilotResponse/);
});
