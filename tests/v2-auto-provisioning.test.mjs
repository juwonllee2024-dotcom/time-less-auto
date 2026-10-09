import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeAutoProvisionRequest,
  createAutoTabManifest,
  bindAutoRoleSlots,
} from '../auto-provisioning.mjs';

const backgroundPath = new URL('../background.js', import.meta.url);
const sidepanelPath = new URL('../sidepanel.js', import.meta.url);
const readBackground = () => fs.readFileSync(backgroundPath, 'utf8');
const readSidepanelJs = () => fs.readFileSync(sidepanelPath, 'utf8');

test('auto request needs no planner or pre-bound tabs', () => {
  assert.deepEqual(normalizeAutoProvisionRequest({}), {
    enabled: true,
    provider: 'chatgpt',
    reuseExisting: false,
    minRoles: 2,
    maxRoles: 6,
  });
  assert.equal(normalizeAutoProvisionRequest({ autoProvision: false }).enabled, false);
  assert.equal(normalizeAutoProvisionRequest({ plannerTabId: 11 }).enabled, false);
});

test('manifest keeps planner separate and creates one fresh tab per role', () => {
  assert.deepEqual(createAutoTabManifest({ roleCount: 3 }), [
    { kind: 'planner', provider: 'chatgpt', roleIndex: null },
    { kind: 'role', provider: 'chatgpt', roleIndex: 0 },
    { kind: 'role', provider: 'chatgpt', roleIndex: 1 },
    { kind: 'role', provider: 'chatgpt', roleIndex: 2 },
  ]);
});

test('role slots map plan order to run-owned tabs', () => {
  const roles = [{ id: 'a', name: 'A', roleGuidance: 'ga' }, { id: 'b', name: 'B', roleGuidance: 'gb' }];
  const participants = [{ id: 'p1' }, { id: 'p2' }];
  const tabs = [{ tabId: 501, provider: 'chatgpt', label: 'ChatGPT A' }, { tabId: 502, provider: 'chatgpt', label: 'ChatGPT B' }];
  const result = bindAutoRoleSlots({ roles, participants, tabs });
  assert.deepEqual(result.roleSlots.map((slot) => [slot.roleId, slot.participantId, slot.tabId]), [['a', 'p1', 501], ['b', 'p2', 502]]);
  assert.deepEqual(result.bindings.map((binding) => binding.tabId), [501, 502]);
});

test('role binding rejects fewer than two role tabs', () => {
  assert.throws(() => bindAutoRoleSlots({ roles: [{ id: 'a' }, { id: 'b' }], participants: [{ id: 'p1' }, { id: 'p2' }], tabs: [{ tabId: 1, provider: 'chatgpt' }] }), /two valid role tabs/);
});

test('role binding ignores empty tab IDs', () => {
  assert.throws(() => bindAutoRoleSlots({
    roles: [{ id: 'a' }, { id: 'b' }],
    participants: [{ id: 'p1' }, { id: 'p2' }],
    tabs: [{ tabId: null, provider: 'chatgpt' }, { tabId: 0, provider: 'chatgpt' }],
  }), /two valid role tabs/);
});

test('background auto branch opens planner without plannerTabId', () => {
  const source = readBackground();
  const start = source.indexOf('async function startAutopilot');
  const end = source.indexOf('async function pauseAutopilot');
  const handler = source.slice(start, end);
  assert.match(handler, /normalizeAutoProvisionRequest/);
  assert.match(handler, /openFreshAiTab\(/);
  assert.match(handler, /autoProvisioning/);
  assert.match(handler, /if \(autoProvision\.enabled\)/);
  assert.match(handler, /if \(!Number\.isInteger\(plannerTabId\)\) throw/);
});

test('background provisions exact validated role count and never removes tabs', () => {
  const source = readBackground();
  assert.match(source, /ensureAutoRoleTabs/);
  assert.match(source, /createAutoTabManifest/);
  assert.match(source, /bindAutoRoleSlots/);
  assert.doesNotMatch(source, /chrome\.tabs\.remove\(/);
});

test('role-tab provisioning failures expose a retryable stage', () => {
  const source = readBackground();
  const start = source.indexOf('async function resolveAutopilotPlan');
  const end = source.indexOf('async function recoverAutopilotPlan', start);
  const handler = source.slice(start, end);
  assert.match(handler, /ROLE_TAB_PROVISION/);
  assert.match(handler, /recordAutopilotFailure\(runId, error, 'ROLE_TAB_PROVISION'\)/);
});

test('main action uses keyword-only auto provisioning', () => {
  const source = readSidepanelJs();
  const start = source.indexOf("els.startAutopilot?.addEventListener");
  const end = source.indexOf("els.pauseAutopilot?.addEventListener", start);
  const handler = source.slice(start, end);
  assert.match(handler, /autoProvision:\s*true/);
  assert.doesNotMatch(handler, /plannerTabId/);
  assert.doesNotMatch(handler, /boundTabCount/);
});

test('empty supported tab list does not disable automatic action', () => {
  const source = readSidepanelJs();
  assert.doesNotMatch(source, /els\.startAutopilot\.disabled\s*=.*!supportedTabs\.length/);
});
