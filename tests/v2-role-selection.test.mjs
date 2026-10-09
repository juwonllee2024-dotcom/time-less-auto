import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAutopilotParticipants } from '../project-engine.mjs';

test('autopilot ignores legacy cards beyond the skeleton role count', () => {
  const meeting = {
    participants: [
      { id: 'p1', slotIndex: 0, role: '생존 전문가', rolePrompt: '자원을 계산한다.' },
      { id: 'p2', slotIndex: 1, role: '싸가지 없는 유학생', rolePrompt: '영어로만 반응한다.' },
      { id: 'legacy-chatgpt', slotIndex: 2, provider: 'chatgpt', tabId: 100, role: '예전 역할' },
      { id: 'legacy-claude', slotIndex: 3, provider: 'claude', tabId: 101, role: '예전 역할 2' },
    ],
  };
  const plan = { roles: [{ id: 'role-a' }, { id: 'role-b' }] };
  assert.deepEqual(selectAutopilotParticipants(meeting, plan).map((participant) => participant.id), ['p1', 'p2']);
});

test('an explicitly added role card can opt into the next run', () => {
  const meeting = {
    participants: [
      { id: 'p1', slotIndex: 0 },
      { id: 'p2', slotIndex: 1 },
      { id: 'p3', slotIndex: 2, roleConfiguredAt: 1234, role: '촬영감독' },
    ],
  };
  const plan = { roles: [{ id: 'role-a' }, { id: 'role-b' }] };
  assert.deepEqual(selectAutopilotParticipants(meeting, plan).map((participant) => participant.id), ['p1', 'p2', 'p3']);
});
