import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSceneContractText,
  buildSceneTransitionCard,
  currentSceneContract,
} from '../scene-contract.mjs';

test('contract text keeps scene budget and ending rule visible', () => {
  const text = buildSceneContractText({
    projectTitle: '무인도',
    sceneNumber: 4,
    totalScenes: 10,
    sceneTitle: '식량 갈등',
    goal: '갈등을 폭발시킨다',
    currentTurn: 2,
    targetTurns: 6,
    maxTurns: 8,
    remainingTargetTurns: 4,
    emotionIntensity: 'high',
    endCondition: '합의 또는 8턴',
  });
  assert.match(text, /Scene: 4\/10/);
  assert.match(text, /2\/6 expected/);
  assert.match(text, /8 maximum/);
  assert.match(text, /합의 또는 8턴/);
});

test('transition card identifies both scene boundaries', () => {
  const card = buildSceneTransitionCard({
    project: { title: '무인도', scenes: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}] },
    fromScene: { index: 3, title: '식량 갈등', targetTurns: 6, maxTurns: 8 },
    toScene: { index: 4, title: '폭풍의 밤', targetTurns: 5, maxTurns: 7, goal: '협력 여부를 결정한다', emotionIntensity: 'very-high', endCondition: '합의 또는 7턴' },
  });
  assert.equal(card.kind, 'SCENE_TRANSITION');
  assert.equal(card.from.index, 3);
  assert.equal(card.to.index, 4);
  assert.match(card.text, /장면 5 \/ 10/);
});

test('current contract derives remaining turns from durable progress', () => {
  const contract = currentSceneContract({
    title: '무인도',
    scenes: [{ index: 0, title: '도착', goal: '시작', targetTurns: 4, maxTurns: 6, emotionIntensity: 'medium', endCondition: '합의' }],
    currentSceneIndex: 0,
    sceneTurnCount: 2,
  });
  assert.equal(contract.currentTurn, 2);
  assert.equal(contract.remainingTargetTurns, 2);
});
