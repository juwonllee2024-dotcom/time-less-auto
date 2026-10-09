import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  SCREENSHOT_MAX_ATTEMPTS,
  buildScreenshotFilename,
  buildV2ScreenshotFilename,
  createScreenshotJob,
  enqueueScreenshotJob,
  markScreenshotJob,
  normalizeResponseClip,
  nextScreenshotJob,
  retryDelayMs,
  validateResponseCapture,
} from '../screenshot-capture.mjs';

const backgroundSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'background.js'), 'utf8');

test('creates deterministic Time Less Auto screenshot jobs', () => {
  const job = createScreenshotJob({
    meetingId: 'meeting-1',
    transactionId: 'tx-1',
    participantId: 'participant-1',
    tabId: 42,
    provider: 'ChatGPT',
    turnNumber: 7,
    responseSignature: 'response-hash',
    createdAt: '2026-08-25T12:00:00.000Z',
  });

  assert.equal(job.key, 'meeting-1:tx-1:7');
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(job.responseSignature, 'response-hash');
  assert.equal(job.filename, 'time-less-auto-v1.0.0/screenshots/meeting-1/turn-007_chatgpt_2026-08-25T12-00-00-000Z.png');
  assert.equal(buildScreenshotFilename({ meetingId: 'm/unsafe', provider: 'Claude', turnNumber: 1, timestamp: '2026-08-25T12:00:00.000Z' }), 'time-less-auto-v1.0.0/screenshots/m-unsafe/turn-001_claude_2026-08-25T12-00-00-000Z.png');
});

test('V2 screenshot names identify scene, turn, provider, and role', () => {
  assert.equal(buildV2ScreenshotFilename({ sceneIndex: 3, turnNumber: 4, provider: 'ChatGPT', roleId: 'survivor' }), 'screenshots/scene-03-turn-004-chatgpt-survivor-response.png');
  const job = createScreenshotJob({ meetingId: 'm', transactionId: 't', participantId: 'p', tabId: 1, provider: 'gemini', turnNumber: 4, version: '2.0.0', sceneIndex: 3, roleId: 'survivor' });
  assert.equal(job.filename, 'screenshots/scene-03-turn-004-gemini-survivor-response.png');
  assert.equal(job.version, '2.0.0');
});

test('deduplicates a screenshot job by meeting, transaction, and turn', () => {
  const job = createScreenshotJob({ meetingId: 'm', transactionId: 't', participantId: 'p', tabId: 1, provider: 'gemini', turnNumber: 2 });
  const once = enqueueScreenshotJob([], job);
  const twice = enqueueScreenshotJob(once, { ...job, status: 'pending', attempts: 0 });
  assert.equal(once.length, 1);
  assert.deepEqual(twice, once);
});

test('retries pending jobs with bounded backoff and stops after three attempts', () => {
  const job = createScreenshotJob({ meetingId: 'm', transactionId: 't', participantId: 'p', tabId: 1, provider: 'gemini', turnNumber: 2 });
  let queue = enqueueScreenshotJob([], job);
  assert.equal(nextScreenshotJob(queue).key, job.key);
  queue = markScreenshotJob(queue, job.key, { status: 'retry', attempts: 1 });
  assert.equal(retryDelayMs(1), 250);
  assert.equal(retryDelayMs(2), 1000);
  assert.equal(retryDelayMs(3), 2000);
  assert.equal(SCREENSHOT_MAX_ATTEMPTS, 3);
  queue = markScreenshotJob(queue, job.key, { status: 'failed', attempts: SCREENSHOT_MAX_ATTEMPTS });
  assert.equal(nextScreenshotJob(queue), null);
});

test('normalizes a document-space response clip without losing the card', () => {
  assert.deepEqual(normalizeResponseClip({ x: 120, y: 240, width: 640, height: 180, coordinateSpace: 'document' }), {
    x: 112, y: 232, width: 656, height: 196, scale: 1,
  });
});

test('accepts only a signed assistant response card as screenshot evidence', () => {
  const evidence = validateResponseCapture({
    expectedSignature: 'sig-answer',
    responseSignature: 'sig-answer',
    responseText: 'The actual assistant answer.',
    captureKind: 'assistant-response',
    responseId: 'assistant-message-17',
    rect: { x: 24, y: 80, width: 420, height: 96, coordinateSpace: 'document' },
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.responseId, 'assistant-message-17');
  assert.deepEqual(evidence.clip, { x: 16, y: 72, width: 436, height: 112, scale: 1 });
});

test('fails closed for planner/user/unknown response nodes and signature drift', () => {
  const base = {
    expectedSignature: 'sig-answer',
    responseSignature: 'sig-answer',
    responseText: 'The actual assistant answer.',
    responseId: 'assistant-message-17',
    rect: { x: 24, y: 80, width: 420, height: 96, coordinateSpace: 'document' },
  };
  for (const captureKind of ['planner', 'user-message', 'unknown', '']) {
    const result = validateResponseCapture({ ...base, captureKind });
    assert.equal(result.ok, false, `capture kind ${captureKind || '(empty)'} must be rejected`);
  }
  assert.equal(validateResponseCapture({ ...base, captureKind: 'assistant-response', responseSignature: 'sig-other' }).ok, false);
  assert.equal(validateResponseCapture({ ...base, captureKind: 'assistant-response', responseId: '' }).ok, false);
  assert.equal(validateResponseCapture({ ...base, captureKind: 'assistant-response', rect: { ...base.rect, coordinateSpace: 'screen' } }).ok, false);
  assert.equal(validateResponseCapture({ ...base, captureKind: 'assistant-response', rect: { ...base.rect, coordinateSpace: '' } }).ok, false);
  assert.equal(validateResponseCapture({ ...base, captureKind: 'assistant-response', rect: { x: 1, y: 2, width: 0, height: 10, coordinateSpace: 'document' } }).ok, false);
});

test('queues screenshot before terminal meeting returns so final response is captured', () => {
  const queueCall = backgroundSource.indexOf('await queueScreenshotCapture(meeting, participant, nextTx);');
  const sessionReturn = backgroundSource.indexOf("if (nextSession.status === 'COMPLETE')");
  const turnLimitReturn = backgroundSource.indexOf('if (meeting.settings.maxTurns > 0 && meeting.currentTurn >= meeting.settings.maxTurns)', queueCall);
  assert.ok(queueCall >= 0, 'completeResponse must enqueue a screenshot');
  assert.ok(queueCall < sessionReturn, 'screenshot queue must run before session completion return');
  assert.ok(queueCall < turnLimitReturn, 'screenshot queue must run before max-turn return');
});

test('uses debugger card capture only and verifies the response before saving', () => {
  assert.match(backgroundSource, /Page\.captureScreenshot/);
  assert.doesNotMatch(backgroundSource, /captureVisibleTab/);
  assert.match(backgroundSource, /responseSignature/);
  assert.match(backgroundSource, /validateResponseCapture/);
  assert.match(backgroundSource, /captureKind/);
  assert.match(backgroundSource, /responseId/);
  assert.match(backgroundSource, /isVerifiedPngData/);
  assert.match(backgroundSource, /Screenshot captured/);
});

test('reuses the Gemini background debugger session instead of double-attaching', () => {
  assert.match(backgroundSource, /backgroundTabController\.isAttached\(job\.tabId\)/);
  assert.match(backgroundSource, /if \(!alreadyAttached\)/);
});

test('processes persisted screenshot jobs after startup and retry alarms', () => {
  assert.match(backgroundSource, /processScreenshotQueue\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(backgroundSource, /SCREENSHOT_RETRY_ALARM/);
  assert.match(backgroundSource, /alarm\?\.name === SCREENSHOT_RETRY_ALARM/);
});

test('exposes capture jobs and opens a completed download without scheduling', () => {
  assert.match(backgroundSource, /case 'LIST_SCREENSHOT_JOBS'/);
  assert.match(backgroundSource, /case 'OPEN_SCREENSHOT'/);
  assert.match(backgroundSource, /downloadId/);
  assert.doesNotMatch(backgroundSource, /daily|schedule daily|periodInMinutes: 1440/i);
});

test('persists download evidence when a card is captured', () => {
  assert.match(backgroundSource, /downloadId: result\.downloadId/);
  assert.match(backgroundSource, /capturedAt/);
});
