import assert from 'node:assert/strict';
import test from 'node:test';
import { buildZipBundle, isVerifiedPngData } from '../zip-builder.mjs';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('accepts only a PNG response-card payload and builds required V2 members', async () => {
  assert.equal(isVerifiedPngData(PNG_BASE64), true);
  const bundle = await buildZipBundle({
    manifest: { schemaVersion: '2.0', planHash: 'sha256:test', bindings: [] },
    runReport: { state: 'COMPLETE', counts: { actualTurns: 1 } },
    screenshots: [{ path: 'screenshots/scene-01-turn-01-chatgpt-role-response.png', dataBase64: PNG_BASE64, verified: true, captureKind: 'assistant-response', responseId: 'chatgpt:dom:assistant-1' }],
  });
  assert.deepEqual(bundle.requiredMissing, []);
  assert.deepEqual(bundle.paths, ['manifest.json', 'run-report.json', 'screenshots/scene-01-turn-01-chatgpt-role-response.png', 'checksums.sha256']);
  assert.match(bundle.checksumsText, /manifest\.json/);
  assert.match(bundle.checksumsText, /run-report\.json/);
  assert.ok(bundle.bytes.length > 100);
});

test('refuses unverified or non-PNG screenshot members', async () => {
  await assert.rejects(
    () => buildZipBundle({ manifest: {}, runReport: {}, screenshots: [{ path: 'screenshots/fake.png', dataBase64: 'not-png', verified: true, captureKind: 'assistant-response', responseId: 'chatgpt:dom:fake' }] }),
    /PNG|verified/i,
  );
  await assert.rejects(
    () => buildZipBundle({ manifest: {}, runReport: {}, screenshots: [{ path: 'screenshots/unverified.png', dataBase64: PNG_BASE64, verified: false, captureKind: 'assistant-response', responseId: 'chatgpt:dom:unverified' }] }),
    /verified/i,
  );
  await assert.rejects(
    () => buildZipBundle({ manifest: {}, runReport: {}, screenshots: [{ path: 'screenshots/unproven.png', dataBase64: PNG_BASE64, verified: true }] }),
    /assistant-response|evidence/i,
  );
});
