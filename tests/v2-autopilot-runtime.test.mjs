import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');

test('plan response gate waits for a complete or quiet response', async () => {
  const protocol = await import('../ai-plan-protocol.mjs');
  assert.equal(typeof protocol.planResponseGate, 'function');

  const partial = protocol.planResponseGate({
    responseText: 'TLA_PLAN_V2_BEGIN {',
    responseSignature: 'sig-a',
    generating: true,
  });
  assert.equal(partial.ready, false);

  const quietOne = protocol.planResponseGate({
    responseText: 'TLA_PLAN_V2_BEGIN {',
    responseSignature: 'sig-a',
    previousSignature: 'sig-a',
    stablePolls: 0,
    generating: false,
  });
  assert.equal(quietOne.ready, false);

  const quietTwo = protocol.planResponseGate({
    responseText: 'TLA_PLAN_V2_BEGIN {',
    responseSignature: 'sig-a',
    previousSignature: 'sig-a',
    stablePolls: 1,
    generating: false,
  });
  assert.equal(quietTwo.ready, true);

  const completeWhileStreaming = protocol.planResponseGate({
    responseText: 'TLA_PLAN_V2_BEGIN {} TLA_PLAN_V2_END',
    responseSignature: 'sig-b',
    generating: true,
  });
  assert.equal(completeWhileStreaming.ready, true);
});

test('autopilot preflight rejects fewer supported AI tabs than roles', async () => {
  const preflight = await import('../autopilot-preflight.mjs').catch(() => ({}));
  assert.equal(typeof preflight.autopilotTabCapacity, 'function');
  const result = preflight.autopilotTabCapacity({
    requiredRoles: 2,
    supportedTabs: [{ tabId: 11, provider: 'chatgpt' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.required, 2);
  assert.equal(result.available, 1);
  assert.match(result.message, /AI/);
});

test('role packet carries the exact creator brief to each AI', async () => {
  const { buildRolePacket } = await import('../role-packet.mjs');
  const packet = buildRolePacket({
    projectBrief: '무인도에서 싸가지 없는 유학생과 생존 전문가가 탈출을 두고 충돌한다.',
    plan: { title: '무인도 생존', premise: '탈출을 두고 충돌한다.', keyword: '무인도' },
    role: {
      id: 'survivor',
      name: '생존 전문가',
      objective: '살아남는다.',
      personality: '냉정하다.',
      speechStyle: '짧게 말한다.',
      roleGuidance: '자원을 계산한다.',
      forbiddenBehaviors: [],
      escalationStyle: '압박한다.',
    },
    scene: {
      id: 'arrival',
      index: 1,
      title: '도착',
      purpose: '첫 충돌',
      setting: '해변',
      goal: '역할을 정한다.',
      emotionStart: 'medium',
      emotionPeak: 'high',
      expectedTurns: 2,
      maxTurns: 4,
      endCondition: '역할 합의',
      transitionInstruction: '다음 장면으로 간다.',
    },
    sceneTurn: 1,
    sceneCount: 1,
    packetId: 'packet-1',
  });
  assert.match(packet.text, /Project brief: 무인도에서 싸가지 없는 유학생과 생존 전문가가 탈출을 두고 충돌한다\./);
});

test('unexpected autopilot failure becomes visible and terminal', async () => {
  const autopilot = await import('../autopilot-engine.mjs');
  assert.equal(typeof autopilot.markAutopilotFailed, 'function');
  const run = autopilot.createAutopilotRun({ runId: 'run-fail', projectBrief: '무인도', plannerTabId: 11, now: 1 });
  const requested = autopilot.transitionAutopilot(run, 'PLAN_REQUESTED', {}, 2);
  const failed = autopilot.markAutopilotFailed(requested, { error: 'Plan response missing', stage: 'PLAN_REQUEST', now: 3 });
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.failureError, 'Plan response missing');
  assert.equal(failed.failureStage, 'PLAN_REQUEST');
});

test('manual project build clears stale autopilot run', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const start = source.indexOf('async function buildProjectRun');
  const end = source.indexOf('async function approveProjectRun', start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /autopilotRun:\s*null/);
});

test('background wires the completion gate, tab preflight, and visible failure path', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(source, /planResponseGate/);
  assert.match(source, /autopilotTabCapacity/);
  assert.match(source, /recordAutopilotFailure/);
  assert.match(source, /projectBrief:\s*run\.projectBrief/);
});

test('autopilot preflight uses only the configured role-slot tabs', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const start = source.indexOf('async function startAutopilot');
  const end = source.indexOf('async function pauseAutopilot', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /roleSlots\.filter\(.*tabId/);
  const injectStart = source.indexOf('async function injectAutopilotRolePackets');
  const injectEnd = source.indexOf('async function waitForPlanResponse', injectStart);
  assert.match(source.slice(injectStart, injectEnd), /roleSlots/);
});

test('autopilot fallback preserves manual slots while auto mode provisions roles', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const start = source.indexOf('async function resolveAutopilotPlan');
  const end = source.indexOf('async function recoverAutopilotPlan', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /const baseFallback\s*=\s*buildLocalSkeletonProjectPlan/);
  assert.match(handler, /alignPlanToRoleSlots\(baseFallback,\s*autoRoleProvisioning \? \[\] : \(run\.roleSlots \|\| \[\]\)/);
  assert.match(handler, /buildPlanRepairPrompt\(\{[\s\S]*roleSlots/);
  assert.match(handler, /ensureAutoRoleTabs/);
});

test('V2 content runtime is isolated from the legacy Lee Relay guard', () => {
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const header = source.split(/\r?\n/).slice(0, 12).join('\n');
  assert.match(header, /__TIME_LESS_AUTO_V2_CONTENT__/);
  assert.doesNotMatch(header, /if\s*\(globalThis\.__LEE_RELAY_BOT_V3__\)/);
});

test('background rejects a legacy content script before injecting the V2 runtime', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(background, /pong\?\.runtime\s*===\s*['"]TIME_LESS_AUTO_V2['"]/);
  assert.match(content, /runtime:\s*['"]TIME_LESS_AUTO_V2['"]/);
});

test('participant sends require a confirmed V2 content runtime', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const start = source.indexOf('async function sendToParticipant');
  const end = source.indexOf('async function attachParticipant', start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /const\s+runtimeReady\s*=\s*await\s+ensureContent/);
  assert.match(source.slice(start, end), /runtimeReady\?\.runtime\s*!==\s*['"]TIME_LESS_AUTO_V2['"]/);
});

test('V2 schedules plan and speaker work through durable Chrome alarms', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(source, /AUTOPILOT_PLAN_ALARM/);
  assert.match(source, /SPEAKER_ALARM/);
  assert.match(source, /chrome\.alarms\.create\(AUTOPILOT_PLAN_ALARM/);
  assert.match(source, /chrome\.alarms\.create\(SPEAKER_ALARM/);
  assert.match(source, /alarm\?\.name === SPEAKER_ALARM/);
  assert.match(source, /enqueue\(\(\) => recoverAutopilotPlan\(\)\)/);
});

test('AI tab catalog normalizes requested providers and preserves order', async () => {
  const catalog = await import('../ai-tab-catalog.mjs').catch(() => ({}));
  assert.equal(typeof catalog.normalizeRequestedProviders, 'function');
  assert.deepEqual(catalog.normalizeRequestedProviders(['claude', 'chatgpt', 'claude', 'unknown']), ['claude', 'chatgpt']);
  assert.equal(catalog.aiTabTarget('gemini').url, 'https://gemini.google.com/app');
});

test('background exposes the AI tab opener command and provider catalog', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(source, /OPEN_AI_TABS/);
  assert.match(source, /chrome\.tabs\.create/);
  assert.match(source, /aiTabTarget/);
  const start = source.indexOf('async function openAiTabs');
  const end = source.indexOf('async function ensureContent', start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /message\.reuseExisting\s*===\s*true/);
  assert.match(source.slice(start, end), /replaceBindings/);
  assert.match(source.slice(start, end), /tabId:\s*null/);
  assert.match(source.slice(start, end), /NEEDS_ATTENTION/);
});

test('Side Panel exposes selectable AI tab open controls', async () => {
  const html = await fs.promises.readFile(path.join(root, 'sidepanel.html'), 'utf8');
  const js = await fs.promises.readFile(path.join(root, 'sidepanel.js'), 'utf8');
  for (const provider of ['chatgpt', 'claude', 'gemini', 'copilot']) assert.match(html, new RegExp(`value=["']${provider}["']`));
  assert.match(html, /id=["']openAiTabs["']/);
  assert.match(html, /새 대화 탭/);
  assert.match(js, /OPEN_AI_TABS/);
  assert.match(js, /plannerValue\s*=\s*String\(els\.plannerTab\.value/);
  assert.match(js, /if\s*\(!plannerValue\)\s*els\.plannerTab\.value/);
});

test('autopilot starts from a keyword without planner or binding selection', async () => {
  const js = await fs.promises.readFile(path.join(root, 'sidepanel.js'), 'utf8');
  const start = js.indexOf('els.startAutopilot?.addEventListener');
  const end = js.indexOf('els.pauseAutopilot', start);
  assert.ok(start >= 0 && end > start);
  const handler = js.slice(start, end);
  assert.match(handler, /autoProvision:\s*true/);
  assert.doesNotMatch(handler, /plannerTabValue/);
  assert.doesNotMatch(handler, /boundTabCount/);
});
