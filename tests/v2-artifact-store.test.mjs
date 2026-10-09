import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactCompleteness, buildManifest, buildRunReport, screenshotMembersFromJobs } from '../artifact-store.mjs';

test('manifest/report contain plan identity, bindings, state events, and measured counts only', () => {
  const plan = { schemaVersion: '2.0', planHash: 'sha256:test', title: '무인도', roles: [], scenes: [] };
  const run = { runId: 'run-1', state: 'RUNNING', events: [{ type: 'PLAN_VALIDATED', at: 1 }], metrics: { expectedTurns: 4, maxTurns: 6, actualTurns: 2, successfulCaptures: 2, failedCaptures: 0, zipFiles: 0 } };
  const manifest = buildManifest({ plan, run, bindings: [{ roleId: 'r1', participantId: 'p1' }], screenshots: [{ path: 'screenshots/a.png', verified: true }] });
  assert.equal(manifest.schemaVersion, '2.0');
  assert.equal(manifest.planHash, 'sha256:test');
  assert.deepEqual(manifest.bindings, [{ roleId: 'r1', participantId: 'p1' }]);
  assert.equal(manifest.screenshots[0].verified, true);
  const report = buildRunReport({ run, artifactSummary: { fileCount: 4 } });
  assert.equal(report.counts.actualTurns, 2);
  assert.equal(report.artifact.fileCount, 4);
  assert.equal(report.events.length, 1);
});

test('only complete verified jobs become screenshot ZIP members', () => {
  const jobs = [
    { status: 'complete', verified: true, captureKind: 'assistant-response', responseId: 'chatgpt:dom:assistant-1', filename: 'screenshots/scene-01-turn-001-chatgpt-r1-response.png', dataBase64: 'png' },
    { status: 'complete', verified: true, filename: 'screenshots/unproven.png', dataBase64: 'png' },
    { status: 'retry', verified: false, filename: 'screenshots/pending.png', dataBase64: 'png' },
  ];
  const members = screenshotMembersFromJobs(jobs);
  assert.equal(members.length, 1);
  assert.equal(members[0].verified, true);
  assert.equal(members[0].captureKind, 'assistant-response');
  assert.equal(members[0].responseId, 'chatgpt:dom:assistant-1');
  assert.deepEqual(artifactCompleteness({ screenshots: members }), { complete: true, missing: [], verifiedCaptures: 1 });
});
