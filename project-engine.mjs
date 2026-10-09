import { canonicalPlanJson, normalizeAiPlan, stablePlanHash } from './ai-plan-protocol.mjs';

export const PROJECT_STATUSES = Object.freeze(['DRAFT', 'APPROVED', 'RUNNING', 'COMPLETE']);
export const PROJECT_DEFAULTS = Object.freeze({
  interactionMode: 'autonomous',
  minDelayMs: 3500,
  captureScreenshots: true,
  retryLimit: 3,
});
export const MAX_ROLE_SLOTS = 6;

const DESERT_ISLAND_ROLES = Object.freeze([
  {
    id: 'survival-expert',
    label: '생존 전문가',
    role: '생존 전문가',
    rolePrompt: '현실적인 자원 계산과 안전을 우선한다. 감정이 커져도 실행 가능한 선택을 말한다.',
  },
  {
    id: 'rude-student',
    label: '싸가지 없는 유학생',
    role: '싸가지 없는 유학생',
    rolePrompt: '영어를 섞어 무심하고 직설적으로 말한다. 숨은 불안과 감정은 행동과 반응으로 드러낸다.',
  },
]);

const DESERT_ISLAND_SCENES = Object.freeze([
  ['arrival', '난파 후 섬 도착', '세 사람이 무인도에 떨어져 서로를 처음 마주한다.', '살아남기 위한 첫 역할과 긴장을 만든다.', '파도에 떠밀려 섬에 도착했다. 누가 먼저 움직일 것인가?', 4, 6, 'medium', '역할 분담 또는 첫 충돌'],
  ['first-night', '첫날 밤', '해가 지고 안전한 잠자리를 정해야 한다.', '공포를 숨기며 임시 야영지를 결정한다.', '어둠이 내려오고, 멀리서 정체 모를 소리가 들린다.', 4, 6, 'medium-high', '야영지 결정 또는 분열'],
  ['food-found', '식량 발견', '작은 식량과 마실 물의 흔적을 찾는다.', '희망과 욕심을 동시에 보여준다.', '바위 뒤에서 며칠치 식량처럼 보이는 상자를 발견한다.', 5, 7, 'high', '분배 원칙 제시'],
  ['food-conflict', '식량 독점 갈등', '누군가 식량을 숨겼다는 의심이 생긴다.', '식량 분배 문제로 갈등을 폭발시킨다.', '상자의 수량이 맞지 않는다. 누군가 먼저 가져간 것이 분명하다.', 6, 8, 'high', '합의, 관계 파탄, 또는 최대 턴'],
  ['storm', '폭풍의 밤', '거센 폭풍이 야영지와 식량을 동시에 위협한다.', '각자의 우선순위가 행동으로 드러난다.', '하늘이 갑자기 검게 변하고, 바람이 야영지를 뜯어낸다.', 5, 7, 'very-high', '기지 방어 또는 대피'],
  ['cave', '숨겨진 동굴', '폭풍 뒤 섬 안쪽에서 동굴과 오래된 흔적을 찾는다.', '섬에 대한 새로운 비밀을 열어 긴장을 유지한다.', '무너진 절벽 안쪽에서 사람 손으로 만든 표식을 발견한다.', 5, 7, 'high', '동굴 진입 또는 철수'],
  ['signal-betrayal', '구조 신호와 배신', '구조 신호를 보낼 자원을 누가 사용할지 갈린다.', '구조 가능성과 개인의 이익을 충돌시킨다.', '연료는 한 번뿐이다. 누군가는 신호를 혼자 쓰려 한다.', 6, 8, 'very-high', '공동 신호 또는 배신 확정'],
  ['injury', '부상자 발생', '한 사람이 다치고 이동 속도가 느려진다.', '책임과 연민의 진짜 크기를 드러낸다.', '절벽 아래에서 비명 소리가 난다. 선택할 시간은 짧다.', 5, 7, 'very-high', '구조 선택 또는 포기'],
  ['escape-choice', '탈출 방법 선택', '뗏목, 신호, 잔류 중 하나를 선택해야 한다.', '서로 다른 생존 철학을 한 결정으로 압축한다.', '마지막으로 쓸 수 있는 재료가 모였다. 이제 하나만 선택할 수 있다.', 6, 8, 'high', '탈출 계획 확정'],
  ['rescue-or-stay', '구조 또는 잔류', '선택의 결과와 관계의 결말을 맞는다.', '이 섬을 떠날지 남을지 감정적인 결론을 만든다.', '수평선에 배가 보인다. 하지만 모두가 같은 결정을 원하는 것은 아니다.', 5, 7, 'very-high', '구조, 잔류, 또는 열린 결말'],
]);

const GENERIC_SCENES = Object.freeze([
  ['setup', '처음 마주한 문제', '주인공들이 상황과 목표를 확인한다.', '핵심 질문과 첫 긴장을 만든다.', 4, 6, 'medium', '첫 계획 합의'],
  ['pressure', '압박이 커진다', '시간이나 자원 제약이 선택을 어렵게 만든다.', '각자의 가치관이 행동으로 드러난다.', 5, 7, 'high', '우선순위 결정'],
  ['conflict', '갈등이 폭발한다', '숨겨진 욕심이나 오해가 겉으로 나온다.', '관계를 되돌리기 어려운 선택을 만든다.', 6, 8, 'very-high', '합의 또는 결렬'],
  ['turn', '예상 밖의 전환', '새 정보가 앞선 계획을 흔든다.', '반전으로 다음 선택의 이유를 만든다.', 5, 7, 'high', '새 계획 채택'],
  ['ending', '결정과 여운', '결과를 받아들이고 다음 가능성을 남긴다.', '짧고 분명한 결말 또는 다음 장면의 문을 연다.', 5, 7, 'high', '결정 완료 또는 열린 결말'],
]);

function clean(value, max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function positiveInt(value, fallback, max = 100000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
}

function nowValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function uid(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function isDesertIsland(keyword) {
  return /무인도|desert(?:ed)?\s+island|\bisland\b/i.test(keyword);
}

function buildScene(raw, index, keyword, generic = false) {
  const [id, title, summary, goal, opening, targetTurns, maxTurns, emotionIntensity, endCondition] = raw;
  return {
    id: `${id}-${index + 1}`,
    index,
    title: clean(title),
    summary: clean(summary),
    goal: clean(goal),
    opening: clean(generic ? `${keyword}에서 ${opening}` : opening),
    targetTurns: positiveInt(targetTurns, 4, 1000),
    maxTurns: Math.max(positiveInt(maxTurns, 6, 1000), positiveInt(targetTurns, 4, 1000)),
    emotionIntensity: clean(emotionIntensity, 40) || 'medium',
    endCondition: clean(endCondition),
    transitionText: generic ? `${keyword} 이야기의 다음 국면으로 넘어간다.` : `무인도 생존 이야기의 다음 국면으로 넘어간다.`,
  };
}

function normalizeRole(role, index) {
  const source = role && typeof role === 'object' ? role : {};
  return {
    id: clean(source.id, 80) || `role-${index + 1}`,
    label: clean(source.label || source.role, 120) || `캐릭터 ${index + 1}`,
    role: clean(source.role || source.label, 120),
    rolePrompt: clean(source.rolePrompt || source.roleGuidance, 500),
    name: clean(source.name || source.label || source.role, 120),
    objective: clean(source.objective, 500),
    personality: clean(source.personality, 500),
    speechStyle: clean(source.speechStyle, 500),
    roleGuidance: clean(source.roleGuidance || source.rolePrompt, 500),
    forbiddenBehaviors: Array.isArray(source.forbiddenBehaviors) ? source.forbiddenBehaviors.map((item) => clean(item, 240)).filter(Boolean) : [],
    escalationStyle: clean(source.escalationStyle, 500),
  };
}

function normalizeScene(scene, index) {
  const source = scene && typeof scene === 'object' ? scene : {};
  const targetTurns = positiveInt(source.targetTurns ?? source.expectedTurns, 4, 1000);
  const maxTurns = Math.max(targetTurns, positiveInt(source.maxTurns, targetTurns + 2, 1000));
  return {
    id: clean(source.id, 100) || `scene-${index + 1}`,
    index,
    title: clean(source.title, 120) || `장면 ${index + 1}`,
    summary: clean(source.summary || source.purpose, 300),
    purpose: clean(source.purpose || source.summary, 300),
    setting: clean(source.setting, 300),
    participants: Array.isArray(source.participants) ? source.participants.map((item) => clean(item, 80)).filter(Boolean) : [],
    goal: clean(source.goal, 300),
    opening: clean(source.opening, 300),
    targetTurns,
    expectedTurns: targetTurns,
    maxTurns,
    emotionStart: clean(source.emotionStart, 80),
    emotionPeak: clean(source.emotionPeak || source.emotionIntensity, 80),
    emotionIntensity: clean(source.emotionIntensity || source.emotionPeak, 80) || 'medium',
    endCondition: clean(source.endCondition, 240),
    transitionText: clean(source.transitionText || source.transitionInstruction, 240),
    transitionInstruction: clean(source.transitionInstruction || source.transitionText, 240),
  };
}

export function normalizeProjectPlan(plan = {}) {
  if (!plan || typeof plan !== 'object') return null;
  const scenes = Array.isArray(plan.scenes) ? plan.scenes.map(normalizeScene) : [];
  const roles = Array.isArray(plan.roles) ? plan.roles.map(normalizeRole) : [];
  const currentSceneIndex = scenes.length ? Math.min(Math.max(0, Math.floor(Number(plan.currentSceneIndex) || 0)), scenes.length - 1) : 0;
  const currentScene = scenes[currentSceneIndex];
  const sceneTurnCount = currentScene ? Math.min(Math.max(0, Math.floor(Number(plan.sceneTurnCount) || 0)), currentScene.maxTurns) : 0;
  const status = PROJECT_STATUSES.includes(plan.status) ? plan.status : 'DRAFT';
  const approvalSource = plan.approval && typeof plan.approval === 'object' ? plan.approval : {};
  const approvedAt = approvalSource.approvedAt == null || approvalSource.approvedAt === ''
    ? null
    : (Number.isFinite(Number(approvalSource.approvedAt)) ? Number(approvalSource.approvedAt) : null);
  const approval = {
    approved: approvalSource.approved === true,
    approvedAt,
    scope: approvalSource.scope === 'scene' ? 'scene' : 'all',
  };
  return {
    ...plan,
    schemaVersion: clean(plan.schemaVersion, 20) || null,
    source: plan.source === 'web-ai' || plan.source === 'local-fallback' ? plan.source : null,
    requestId: clean(plan.requestId, 120),
    requestNonce: clean(plan.requestNonce, 180),
    id: clean(plan.id, 120) || uid('project'),
    keyword: clean(plan.keyword, 80),
    title: clean(plan.title, 160) || '새 프로젝트',
    premise: clean(plan.premise, 600),
    hook: clean(plan.hook, 400),
    language: clean(plan.language, 40),
    tone: clean(plan.tone, 120),
    roles,
    scenes,
    currentSceneIndex,
    sceneTurnCount,
    status,
    approval,
    defaults: { ...PROJECT_DEFAULTS, ...(plan.defaults || {}) },
    runPolicy: plan.runPolicy && typeof plan.runPolicy === 'object'
      ? { ...plan.runPolicy, mode: ['autonomous', 'interactive'].includes(plan.runPolicy.mode) ? plan.runPolicy.mode : PROJECT_DEFAULTS.interactionMode, turnUnit: 'provider_response', expectedTotalTurns: scenes.reduce((sum, scene) => sum + scene.expectedTurns, 0), maxTotalTurns: scenes.reduce((sum, scene) => sum + scene.maxTurns, 0) }
      : { mode: PROJECT_DEFAULTS.interactionMode, turnUnit: 'provider_response', aiIntervalMs: PROJECT_DEFAULTS.minDelayMs, expectedTotalTurns: scenes.reduce((sum, scene) => sum + scene.expectedTurns, 0), maxTotalTurns: scenes.reduce((sum, scene) => sum + scene.maxTurns, 0) },
    capturePolicy: plan.capturePolicy && typeof plan.capturePolicy === 'object'
      ? { ...plan.capturePolicy, mode: 'actual_response_only', retryLimit: positiveInt(plan.capturePolicy.retryLimit, PROJECT_DEFAULTS.retryLimit, 5), zipRequiredFiles: Array.isArray(plan.capturePolicy.zipRequiredFiles) ? plan.capturePolicy.zipRequiredFiles.map((item) => clean(item, 160)).filter(Boolean) : ['manifest.json', 'run-report.json', 'checksums.sha256'] }
      : { mode: 'actual_response_only', retryLimit: PROJECT_DEFAULTS.retryLimit, zipRequiredFiles: ['manifest.json', 'run-report.json', 'checksums.sha256'] },
    totalExpectedTurns: scenes.reduce((sum, scene) => sum + scene.targetTurns, 0),
    totalMaxTurns: scenes.reduce((sum, scene) => sum + scene.maxTurns, 0),
    createdAt: nowValue(plan.createdAt),
    updatedAt: nowValue(plan.updatedAt || plan.createdAt),
  };
}

/**
 * Select the character cards that belong to a V2 project run.
 *
 * The first two cards are the local skeleton's required roles. Cards added
 * explicitly after the skeleton are opt-in through roleConfiguredAt; this
 * keeps legacy tabs/cards from silently becoming project roles after an
 * upgrade while still allowing the creator to add a new role deliberately.
 */
export function selectAutopilotParticipants(meeting = {}, basePlan = {}) {
  const participants = Array.isArray(meeting?.participants) ? meeting.participants.filter(Boolean) : [];
  if (!participants.length) return [];
  const skeletonRoleCount = Math.min(
    MAX_ROLE_SLOTS,
    Math.max(2, Math.floor(Number(basePlan?.roles?.length) || 0)),
  );
  const selectedCount = Math.min(participants.length, skeletonRoleCount);
  const selected = participants.slice(0, selectedCount);
  const selectedIds = new Set(selected.map((participant) => participant.id));
  for (const participant of participants.slice(selectedCount)) {
    const roleConfiguredAt = Number(participant?.roleConfiguredAt);
    if ((Number.isFinite(roleConfiguredAt) && roleConfiguredAt > 0) || participant?.autopilotRoleActive === true) {
      if (!selectedIds.has(participant.id)) {
        selected.push(participant);
        selectedIds.add(participant.id);
      }
    }
    if (selected.length >= MAX_ROLE_SLOTS) break;
  }
  return selected;
}

/**
 * Make the selected character cards authoritative for a V2 run.
 * Web AI may enrich a role, but it cannot change card order, count, id, or
 * explicit role guidance. Scene casts remain scene-specific when supplied.
 */
export function alignPlanToRoleSlots(plan = {}, roleSlots = []) {
  const normalized = normalizeProjectPlan(plan);
  if (!normalized) return null;
  if (!Array.isArray(roleSlots) || roleSlots.length === 0) return normalized;
  if (roleSlots.length > MAX_ROLE_SLOTS) throw new Error(`A V2 project supports at most ${MAX_ROLE_SLOTS} role slots.`);

  const sourceRoles = Array.isArray(normalized.roles) ? normalized.roles : [];
  const sourceIds = new Map(sourceRoles.map((role, index) => [role.id, index]));
  const usedIds = new Set();
  const uniqueRoleId = (slot, source, index) => {
    const base = clean(slot?.roleId, 80) || clean(source?.id, 80) || `role-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    return id;
  };

  const roles = roleSlots.map((slot = {}, index) => {
    const source = sourceRoles[index] || {};
    const roleId = uniqueRoleId(slot, source, index);
    const configuredRole = clean(slot.role, 120);
    const configuredGuidance = clean(slot.rolePrompt || slot.roleGuidance, 500);
    return normalizeRole({
      ...source,
      id: roleId,
      ...(configuredRole ? {
        name: configuredRole,
        label: configuredRole,
        role: configuredRole,
      } : {}),
      ...(configuredGuidance ? {
        rolePrompt: configuredGuidance,
        roleGuidance: configuredGuidance,
      } : {}),
    }, index);
  });

  const roleIds = roles.map((role) => role.id);
  const scenes = normalized.scenes.map((scene) => {
    const participants = [];
    for (const participantId of Array.isArray(scene.participants) ? scene.participants : []) {
      const sourceIndex = sourceIds.get(clean(participantId, 100));
      const mapped = sourceIndex == null ? clean(participantId, 100) : roleIds[sourceIndex];
      if (mapped && roleIds.includes(mapped) && !participants.includes(mapped)) participants.push(mapped);
    }
    if (!participants.length && (!Array.isArray(scene.participants) || scene.participants.length === 0)) {
      for (const roleId of roleIds) participants.push(roleId);
    }
    return { ...scene, participants };
  });

  // Keep alignment idempotent: the same role contract must produce the same
  // plan hash across retries, reloads, and scene transitions.
  const aligned = normalizeProjectPlan({ ...normalized, roles, scenes, updatedAt: normalized.updatedAt });
  const { planHash: _ignoredPlanHash, ...hashable } = aligned;
  return { ...aligned, planHash: stablePlanHash(canonicalPlanJson(hashable)) };
}

export function buildProjectPlan(keyword, options = {}) {
  const normalizedKeyword = clean(keyword, 80);
  if (!normalizedKeyword) throw new Error('프로젝트 키워드를 입력해주세요.');
  const desert = isDesertIsland(normalizedKeyword);
  const scenes = (desert ? DESERT_ISLAND_SCENES : GENERIC_SCENES)
    .map((scene, index) => buildScene(scene, index, normalizedKeyword, !desert));
  const roles = desert
    ? DESERT_ISLAND_ROLES.map((role) => ({ ...role }))
    : [
      { id: 'lead', label: '주도자', role: '주도자', rolePrompt: '목표를 분명히 하고 다음 행동을 제안한다.' },
      { id: 'challenger', label: '반대자', role: '반대자', rolePrompt: '허점을 지적하고 감정적 긴장을 만든다.' },
    ];
  const now = nowValue(options.now);
  return normalizeProjectPlan({
    id: options.id || uid('project'),
    keyword: normalizedKeyword,
    title: desert ? '무인도 생존 회의' : `${normalizedKeyword} 이야기`,
    premise: desert
      ? '무인도에 갇힌 사람들이 생존 자원과 서로의 신뢰를 두고 갈등한다.'
      : `${normalizedKeyword}에서 인물들이 문제를 마주하고 선택을 거쳐 결말에 도달한다.`,
    roles,
    scenes,
    currentSceneIndex: 0,
    sceneTurnCount: 0,
    status: 'DRAFT',
    approval: { approved: false, approvedAt: null, scope: 'all' },
    defaults: { ...PROJECT_DEFAULTS },
    createdAt: now,
    updatedAt: now,
  });
}

export function currentProjectScene(plan) {
  const normalized = normalizeProjectPlan(plan);
  return normalized?.scenes[normalized.currentSceneIndex] || null;
}

export function recordProjectTurn(plan, options = {}) {
  const normalized = normalizeProjectPlan(plan);
  if (!normalized || !normalized.scenes.length || normalized.status === 'COMPLETE') {
    return { plan: normalized, transition: null, completed: true };
  }
  const scene = normalized.scenes[normalized.currentSceneIndex];
  const nextTurn = normalized.sceneTurnCount + 1;
  const hitTarget = nextTurn >= scene.targetTurns;
  const hitMaximum = nextTurn >= scene.maxTurns;
  if (!hitTarget && !hitMaximum) {
    return {
      plan: normalizeProjectPlan({ ...normalized, status: 'RUNNING', sceneTurnCount: nextTurn, updatedAt: nowValue(options.now) }),
      transition: null,
      completed: false,
    };
  }
  const nextIndex = normalized.currentSceneIndex + 1;
  if (nextIndex >= normalized.scenes.length) {
    return {
      plan: normalizeProjectPlan({ ...normalized, status: 'COMPLETE', sceneTurnCount: nextTurn, updatedAt: nowValue(options.now) }),
      transition: null,
      completed: true,
    };
  }
  const nextScene = normalized.scenes[nextIndex];
  return {
    plan: normalizeProjectPlan({ ...normalized, status: 'RUNNING', currentSceneIndex: nextIndex, sceneTurnCount: 0, updatedAt: nowValue(options.now) }),
    transition: { from: scene, to: nextScene, reason: hitMaximum && !hitTarget ? 'max-turns' : 'target-turns' },
    completed: false,
  };
}

function v2RoleFromLegacy(role, index) {
  const name = clean(role?.label || role?.role || role?.name, 120) || `Role ${index + 1}`;
  const guidance = clean(role?.rolePrompt || role?.roleGuidance, 500) || 'Stay consistent with this role and react to the current scene.';
  return {
    id: clean(role?.id, 80) || `role-${index + 1}`,
    name,
    objective: clean(role?.objective, 500) || (index === 0 ? 'Keep the project moving.' : 'Challenge the other role and reveal new stakes.'),
    personality: clean(role?.personality, 500) || guidance,
    speechStyle: clean(role?.speechStyle, 500) || 'Natural, concise dialogue with visible emotion.',
    roleGuidance: guidance,
    forbiddenBehaviors: Array.isArray(role?.forbiddenBehaviors) ? role.forbiddenBehaviors.map((item) => clean(item, 240)).filter(Boolean) : [],
    escalationStyle: clean(role?.escalationStyle, 500) || (index === 0 ? 'Measured pressure.' : 'Direct pushback.'),
  };
}

function v2SceneFromLegacy(scene, index, roleIds) {
  const emotion = clean(scene?.emotionIntensity, 80) || 'medium';
  return {
    id: clean(scene?.id, 100) || `scene-${index + 1}`,
    index: index + 1,
    title: clean(scene?.title, 120) || `Scene ${index + 1}`,
    purpose: clean(scene?.purpose || scene?.summary, 300) || 'Move the project forward.',
    setting: clean(scene?.setting, 300) || clean(scene?.title, 120) || `Scene ${index + 1}`,
    participants: Array.isArray(scene?.participants) && scene.participants.length >= 2 ? scene.participants.map((item) => clean(item, 80)).filter(Boolean) : roleIds,
    opening: clean(scene?.opening, 300) || 'The scene begins.',
    goal: clean(scene?.goal, 300) || 'Create a meaningful change.',
    emotionStart: clean(scene?.emotionStart, 80) || emotion,
    emotionPeak: clean(scene?.emotionPeak, 80) || emotion,
    expectedTurns: positiveInt(scene?.expectedTurns ?? scene?.targetTurns, 4, 20),
    maxTurns: Math.min(20, Math.max(positiveInt(scene?.maxTurns, 6, 20), positiveInt(scene?.expectedTurns ?? scene?.targetTurns, 4, 20))),
    endCondition: clean(scene?.endCondition, 240) || 'The scene goal is reached.',
    transitionInstruction: clean(scene?.transitionInstruction || scene?.transitionText, 240) || 'Continue to the next scene.',
  };
}

export function buildLocalSkeletonProjectPlan(keyword, options = {}) {
  const base = buildProjectPlan(keyword, options);
  const now = nowValue(options.now);
  const roles = base.roles.map(v2RoleFromLegacy);
  const roleIds = roles.map((role) => role.id);
  const scenes = base.scenes.map((scene, index) => v2SceneFromLegacy(scene, index, roleIds));
  const plan = normalizeProjectPlan({
    ...base,
    schemaVersion: '2.0',
    source: 'local-fallback',
    requestId: clean(options.requestId, 120) || uid('run'),
    requestNonce: clean(options.requestNonce, 180) || uid('nonce'),
    project: {
      id: base.id,
      title: base.title,
      premise: base.premise,
      language: options.language || 'ko',
      tone: options.tone || 'emotion-forward roleplay',
      hook: base.title,
    },
    language: options.language || 'ko',
    tone: options.tone || 'emotion-forward roleplay',
    hook: base.title,
    roles,
    scenes,
    runPolicy: {
      mode: base.defaults.interactionMode,
      turnUnit: 'provider_response',
      aiIntervalMs: base.defaults.minDelayMs,
      expectedTotalTurns: scenes.reduce((sum, scene) => sum + scene.expectedTurns, 0),
      maxTotalTurns: scenes.reduce((sum, scene) => sum + scene.maxTurns, 0),
    },
    capturePolicy: {
      mode: 'actual_response_only',
      retryLimit: base.defaults.retryLimit,
      zipRequiredFiles: ['manifest.json', 'run-report.json', 'checksums.sha256'],
    },
    currentSceneIndex: 0,
    sceneTurnCount: 0,
    status: 'DRAFT',
    approval: { approved: false, approvedAt: null, scope: 'all' },
    createdAt: now,
    updatedAt: now,
  });
  const normalized = normalizeProjectPlan(plan);
  return { ...normalized, planHash: stablePlanHash(canonicalPlanJson(normalized)) };
}

export function adaptAiProjectPlan({ aiPlan, keyword = '', requestId = '', requestNonce = '', now = Date.now() } = {}) {
  const result = normalizeAiPlan(aiPlan, { keyword, requestId, requestNonce, now });
  if (!result.ok) {
    const failure = new Error(result.errors.map((item) => `${item.code} ${item.path}`).join('; ') || 'AI plan is invalid.');
    failure.code = 'PLAN_INVALID';
    failure.errors = result.errors;
    throw failure;
  }
  return normalizeProjectPlan({ ...result.plan, source: 'web-ai', requestId, requestNonce, updatedAt: nowValue(now) });
}
