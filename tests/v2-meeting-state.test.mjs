import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeeting, durableMeetingState, publicMeetingState } from '../meeting-engine.mjs';

test('meeting state carries V2 autopilot and artifact defaults', () => {
  const meeting = createMeeting({ now: 1000 });
  assert.equal(meeting.autopilotRun, null);
  assert.equal(meeting.artifactSummary, null);
  assert.equal(publicMeetingState(meeting).autopilotRun, null);
  assert.equal(durableMeetingState(meeting).artifactSummary, null);
});

test('durable V2 state preserves autopilot metadata while clearing tab bindings', () => {
  const meeting = createMeeting({ now: 1000 });
  const next = durableMeetingState({ ...meeting, autopilotRun: { runId: 'run-1', state: 'PAUSED' }, artifactSummary: { files: 2 } });
  assert.deepEqual(next.autopilotRun, { runId: 'run-1', state: 'PAUSED' });
  assert.deepEqual(next.artifactSummary, { files: 2 });
  assert.ok(next.participants.every((participant) => participant.tabId === null));
});

test('project design grows participant cards to match generated role count', async () => {
  const { ensureParticipantSlots } = await import('../meeting-engine.mjs');
  assert.equal(typeof ensureParticipantSlots, 'function');
  const meeting = createMeeting({ now: 1000 });
  const sparse = { ...meeting, participants: meeting.participants.slice(0, 1) };
  const expanded = ensureParticipantSlots(sparse, 2);
  assert.equal(expanded.participants.length, 2);
  assert.equal(expanded.participants[1].slotIndex, 1);
});

test('resetting a stopped autopilot restores an editable clean meeting', async () => {
  const { resetAutopilotMeeting } = await import('../meeting-engine.mjs');
  assert.equal(typeof resetAutopilotMeeting, 'function');
  const meeting = createMeeting({ now: 1000 });
  const stopped = {
    ...meeting,
    status: 'FINISHED',
    projectPlan: { id: 'project-1' },
    autopilotRun: { runId: 'run-1', state: 'CANCELLED' },
    artifactSummary: { status: 'INCOMPLETE' },
    currentTurn: 4,
    sceneTurnCount: 2,
    nextSpeakerParticipantId: meeting.participants[0].id,
    activeTransaction: { transactionId: 'tx-1' },
    transcript: [{ id: 'entry-1' }],
  };
  const reset = resetAutopilotMeeting(stopped, 2000);
  assert.equal(reset.status, 'READY');
  assert.equal(reset.projectPlan, null);
  assert.equal(reset.autopilotRun, null);
  assert.equal(reset.artifactSummary, null);
  assert.equal(reset.currentTurn, 0);
  assert.equal(reset.sceneTurnCount, 0);
  assert.equal(reset.activeTransaction, null);
  assert.equal(reset.nextSpeakerParticipantId, null);
  assert.deepEqual(reset.transcript, []);
  assert.equal(reset.updatedAt, 2000);
});

test('autopilot reset clears run artifacts but preserves creator role guidance', async () => {
  const { resetAutopilotMeeting } = await import('../meeting-engine.mjs');
  const meeting = createMeeting({ now: 1000 });
  const configured = {
    ...meeting,
    participants: meeting.participants.map((participant, index) => ({
      ...participant,
      role: index === 0 ? '생존 전문가' : '싸가지 없는 유학생',
      rolePrompt: index === 0 ? '자원을 계산한다.' : '영어로만 반응한다.',
    })),
    projectPlan: { id: 'project-1' },
    autopilotRun: { runId: 'run-1', state: 'FAILED' },
    artifactSummary: { status: 'INCOMPLETE' },
  };
  const reset = resetAutopilotMeeting(configured, 2000);
  assert.deepEqual(reset.participants.map((participant) => ({ role: participant.role, rolePrompt: participant.rolePrompt })), [
    { role: '생존 전문가', rolePrompt: '자원을 계산한다.' },
    { role: '싸가지 없는 유학생', rolePrompt: '영어로만 반응한다.' },
  ]);
  assert.equal(reset.projectPlan, null);
  assert.equal(reset.autopilotRun, null);
  assert.equal(reset.artifactSummary, null);
});
