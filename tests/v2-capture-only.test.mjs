import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createMeeting, durableMeetingState } from '../meeting-engine.mjs';

const root = path.join(import.meta.dirname, '..');

test('durable V2 state does not persist raw AI chat text', () => {
  const meeting = createMeeting({ now: 1000 });
  const durable = durableMeetingState({
    ...meeting,
    transcript: [
      { speakerType: 'USER', text: '무인도에서 시작해.' },
      { speakerType: 'AI', text: 'This is the private response text.', transactionId: 'tx-1' },
      { speakerType: 'SYSTEM', text: '장면 전환', kind: 'SCENE_TRANSITION' },
    ],
  });
  assert.equal(durable.transcript[0].text, '무인도에서 시작해.');
  assert.equal(durable.transcript[1].text, '');
  assert.equal(durable.transcript[1].transactionId, 'tx-1');
  assert.equal(durable.transcript[2].text, '장면 전환');
});

test('side panel presents autopilot AI turns through the captured PNG instead of raw text', () => {
  const source = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8');
  assert.match(source, /screenshot-only|캡처로만|실제 응답 캡처/);
  assert.match(source, /OPEN_SCREENSHOT/);
  assert.match(source, /dataBase64|downloadId/);
});
