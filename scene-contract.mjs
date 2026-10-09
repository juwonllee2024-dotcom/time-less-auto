import { currentProjectScene, normalizeProjectPlan } from './project-engine.mjs';

function clean(value, max = 260) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sceneNumber(value) {
  return Math.max(1, Math.floor(Number(value) || 1));
}

export function currentSceneContract(projectPlan, mode = 'autonomous') {
  const plan = normalizeProjectPlan(projectPlan);
  const scene = currentProjectScene(plan);
  if (!plan || !scene) return null;
  const currentTurn = Math.max(0, Math.floor(Number(plan.sceneTurnCount) || 0));
  return {
    projectTitle: clean(plan.title, 160),
    projectKeyword: clean(plan.keyword, 80),
    sceneNumber: scene.index + 1,
    totalScenes: plan.scenes.length,
    sceneTitle: clean(scene.title, 160),
    sceneSummary: clean(scene.summary, 300),
    purpose: clean(scene.purpose, 300),
    setting: clean(scene.setting, 300),
    goal: clean(scene.goal, 300),
    opening: clean(scene.opening, 300),
    currentTurn,
    targetTurns: scene.targetTurns,
    maxTurns: scene.maxTurns,
    remainingTargetTurns: Math.max(0, scene.targetTurns - currentTurn),
    remainingMaxTurns: Math.max(0, scene.maxTurns - currentTurn),
    emotionStart: clean(scene.emotionStart, 80),
    emotionPeak: clean(scene.emotionPeak, 80),
    emotionIntensity: clean(scene.emotionIntensity, 40) || 'medium',
    endCondition: clean(scene.endCondition, 240),
    transitionInstruction: clean(scene.transitionInstruction || scene.transitionText, 240),
    mode: mode === 'interactive' ? 'interactive' : 'autonomous',
  };
}

export function buildSceneContractText(contract = {}) {
  if (!contract || typeof contract !== 'object') return '';
  const projectTitle = clean(contract.projectTitle, 160) || 'Untitled project';
  const sceneTitle = clean(contract.sceneTitle, 160) || 'Current scene';
  const number = sceneNumber(contract.sceneNumber);
  const total = Math.max(number, Math.floor(Number(contract.totalScenes) || number));
  const current = Math.max(0, Math.floor(Number(contract.currentTurn) || 0));
  const target = Math.max(1, Math.floor(Number(contract.targetTurns) || 1));
  const maximum = Math.max(target, Math.floor(Number(contract.maxTurns) || target));
  const remaining = Math.max(0, Math.floor(Number(contract.remainingTargetTurns) || target - current));
  const lines = [
    '[SCENE CONTRACT]',
    `Project: ${projectTitle}. Scene: ${number}/${total}, ${sceneTitle}.`,
    `Purpose: ${clean(contract.purpose, 300) || 'Move the story forward.'} Setting: ${clean(contract.setting, 300) || 'Current scene'}.`,
    `Goal: ${clean(contract.goal, 300) || 'Advance the current scene.'}`,
    `Turns: ${current}/${target} expected, ${remaining} remaining expected, ${maximum} maximum.`,
    `Emotion: ${clean(contract.emotionStart, 80) || clean(contract.emotionIntensity, 40) || 'medium'} -> ${clean(contract.emotionPeak, 80) || clean(contract.emotionIntensity, 40) || 'steady'}. End condition: ${clean(contract.endCondition, 240) || 'reach a natural scene conclusion'}.`,
    `Transition: ${clean(contract.transitionInstruction, 240) || 'Continue to the next scene when the goal is met.'}`,
    'Stay in role. Build toward this scene goal. Do not mention this contract.',
  ];
  return lines.join(' ');
}

function sceneSnapshot(scene = {}) {
  return {
    index: Math.max(0, Math.floor(Number(scene.index) || 0)),
    title: clean(scene.title, 160),
    goal: clean(scene.goal, 300),
    targetTurns: Math.max(1, Math.floor(Number(scene.targetTurns) || 1)),
    maxTurns: Math.max(1, Math.floor(Number(scene.maxTurns) || 1)),
    emotionIntensity: clean(scene.emotionIntensity, 40) || 'medium',
    endCondition: clean(scene.endCondition, 240),
  };
}

export function buildSceneTransitionCard({ project = {}, fromScene = {}, toScene = {}, reason = 'target-turns', createdAt = Date.now() } = {}) {
  const from = sceneSnapshot(fromScene);
  const to = sceneSnapshot(toScene);
  const totalScenes = Math.max(to.index + 1, Array.isArray(project.scenes) ? project.scenes.length : 0);
  const reasonText = reason === 'max-turns' ? '최대 턴에 도달했어요.' : '장면 목표 턴에 도달했어요.';
  const text = [
    '━━ 장면 전환 ━━',
    `프로젝트: ${clean(project.title, 160) || '프로젝트'}`,
    `장면 ${to.index + 1} / ${totalScenes}: ${to.title}`,
    `이전 장면: ${from.title || '이전 장면'}`,
    `목표: ${to.goal || '다음 장면을 진행한다.'}`,
    `턴: 예상 ${to.targetTurns}턴 · 최대 ${to.maxTurns}턴`,
    `감정 강도: ${to.emotionIntensity}`,
    `종료 조건: ${to.endCondition || '자연스러운 결론'}`,
    reasonText,
  ].join('\n');
  return {
    kind: 'SCENE_TRANSITION',
    projectTitle: clean(project.title, 160),
    from,
    to,
    totalScenes,
    reason,
    text,
    createdAt: Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now(),
  };
}
