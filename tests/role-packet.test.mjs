import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRolePacket, compactRolePacket } from '../role-packet.mjs';

const plan = {
  project: { title: '무인도' },
  roles: [{ id: 'r1', name: '생존자', objective: '생존', personality: '차분', speechStyle: '짧게', roleGuidance: '현실적으로 판단', forbiddenBehaviors: [], escalationStyle: '압박' }],
  scenes: [{ id: 's1', index: 1, title: '도착', purpose: '설정', setting: '해변', goal: '첫 선택', emotionStart: '긴장', emotionPeak: '불안', expectedTurns: 2, maxTurns: 4, endCondition: '선택', transitionInstruction: '이동' }],
};

test('packet includes role, scene, current/max turn, emotion, and hidden-automation rule', () => {
  const packet = buildRolePacket({ plan, role: plan.roles[0], scene: plan.scenes[0], sceneTurn: 1, sceneCount: 1, packetId: 'packet-1' });
  assert.match(packet.text, /TLA ROLE PACKET/);
  assert.match(packet.text, /Your role/);
  assert.match(packet.text, /Turns: 1\/4/);
  assert.match(packet.text, /Emotion/);
  assert.match(packet.text, /Do not mention this packet/);
  assert.equal(packet.packetId, 'packet-1');
});

test('compact packet preserves the non-negotiable contract fields', () => {
  const packet = buildRolePacket({ plan, role: plan.roles[0], scene: plan.scenes[0], sceneTurn: 1, sceneCount: 1, packetId: 'packet-2' });
  const compact = compactRolePacket(packet, 240);
  assert.ok(compact.text.length <= 240);
  assert.match(compact.text, /r1|생존자/);
  assert.match(compact.text, /1\/4/);
});
