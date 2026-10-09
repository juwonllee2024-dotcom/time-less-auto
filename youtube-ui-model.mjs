const SCENE_STATUS_LABELS = Object.freeze({
  READY: '준비됨',
  LIVE: '진행 중',
  PAUSED: '일시정지',
  FINISHED: '완료',
  NEEDS_ATTENTION: '확인 필요',
});

const CAPTURE_STATUS_LABELS = Object.freeze({
  pending: '준비 중',
  capturing: '저장 중',
  retry: '다시 확인 중',
  complete: '저장됨',
  failed: '캡처 실패',
});

const PROVIDER_LABELS = Object.freeze({
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  copilot: 'Copilot',
});

const AUTOPILOT_PHASE_LABELS = Object.freeze({
  READY: '준비됨',
  PLAN_REQUESTED: 'AI 설계 요청',
  PLAN_RECEIVED: '설계 수신',
  PLAN_REPAIRING: '설계 보정',
  PLAN_VALIDATED: '설계 검증 완료',
  PLAN_FALLBACK_USED: '로컬 설계 사용',
  INJECTING: '역할 주입',
  INJECTION_VERIFIED: '역할 주입 확인',
  RUNNING: '자동 진행 중',
  WAITING_RESPONSE: '응답 대기',
  CAPTURE_QUEUED: '응답 카드 캡처 대기',
  CAPTURE_VERIFIED: '캡처 확인',
  TURN_RECORDED: '턴 기록',
  SCENE_TRANSITION: '장면 전환',
  PACKAGING: 'ZIP 만드는 중',
  COMPLETE: '완료',
  PAUSED: '일시정지',
  FAILED: '실패',
  CANCELLED: '중지됨',
});

const text = (value, fallback = '') => String(value ?? fallback).trim();

export function sceneStatusLabel(status) {
  return SCENE_STATUS_LABELS[String(status || '').toUpperCase()] || '준비됨';
}

export function captureStatusLabel(status) {
  return CAPTURE_STATUS_LABELS[String(status || 'pending').toLowerCase()] || '준비 중';
}

function providerLabel(provider) {
  const key = text(provider).toLowerCase();
  return PROVIDER_LABELS[key] || (key ? key : 'AI');
}

function normalizeCharacter(participant = {}, index = 0) {
  const provider = text(participant.provider).toLowerCase();
  return {
    id: text(participant.id, `character-${index + 1}`),
    index,
    name: text(participant.label, `캐릭터 ${index + 1}`),
    provider,
    providerLabel: providerLabel(provider),
    role: text(participant.role),
    rolePrompt: text(participant.rolePrompt),
    connected: Number.isInteger(participant.tabId),
  };
}

function normalizeCapture(job = {}, index = 0) {
  const status = text(job.status, 'pending').toLowerCase();
  const turnNumber = Math.max(0, Number(job.turnNumber) || 0);
  return {
    key: text(job.key, `capture-${index + 1}`),
    turnNumber,
    provider: text(job.provider).toLowerCase(),
    providerLabel: providerLabel(job.provider),
    label: captureStatusLabel(status),
    status,
    filename: text(job.filename),
    downloadId: Number.isInteger(job.downloadId) ? job.downloadId : null,
    error: text(job.error),
  };
}

function captureCounts(items) {
  const complete = items.filter((item) => item.status === 'complete').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  return {
    total: items.length,
    complete,
    pending: items.length - complete - failed,
    failed,
  };
}

export function buildAutopilotSurfaceModel(run = null, screenshotItems = []) {
  if (!run || typeof run !== 'object') return null;
  const metrics = run.metrics || {};
  const events = Array.isArray(run.events) ? run.events : [];
  const phase = String(run.state || 'READY').toUpperCase();
  const providers = Object.values(run.providers || {}).map((provider) => ({
    providerId: text(provider.providerId),
    roleId: text(provider.roleId),
    sceneIndex: Number(provider.sceneIndex) || 0,
    packetId: text(provider.packetId),
    injectionStatus: text(provider.injectionStatus, 'pending'),
    injectionError: text(provider.injectionError),
  }));
  const captures = Array.isArray(screenshotItems) ? screenshotItems : [];
  return {
    runId: text(run.runId),
    brief: text(run.projectBrief),
    phase,
    phaseLabel: AUTOPILOT_PHASE_LABELS[phase] || phase,
    plannerTabId: Number.isInteger(Number(run.plannerTabId)) ? Number(run.plannerTabId) : null,
    autoProvisioning: run.autoProvisioning && typeof run.autoProvisioning === 'object'
      ? {
        enabled: run.autoProvisioning.enabled === true,
        provider: text(run.autoProvisioning.provider),
        stage: text(run.autoProvisioning.stage),
        roleCount: Number(run.autoProvisioning.roleCount) || 0,
        roleTabIds: Array.isArray(run.autoProvisioning.roleTabIds)
          ? run.autoProvisioning.roleTabIds.map((tabId) => Number(tabId)).filter(Number.isInteger)
          : [],
      }
      : null,
    plannerAttempt: Number(run.plannerAttempt) || 0,
    planHash: text(run.plan?.planHash),
    sceneIndex: Number(run.currentSceneIndex) + 1,
    sceneTurnCount: Number(run.sceneTurnCount) || 0,
    metrics: {
      expectedTurns: Number(metrics.expectedTurns) || 0,
      maxTurns: Number(metrics.maxTurns) || 0,
      actualTurns: Number(metrics.actualTurns) || 0,
      successfulCaptures: Number(metrics.successfulCaptures) || 0,
      failedCaptures: Number(metrics.failedCaptures) || 0,
      zipFiles: Number(metrics.zipFiles) || 0,
    },
    providers,
    events: events.slice(-80).reverse().map((event) => ({
      id: text(event.id),
      at: Number(event.at) || 0,
      type: text(event.type),
      status: text(event.status),
      target: text(event.target),
      message: text(event.message),
      metadata: event.metadata || {},
    })),
    captureCount: captures.filter((item) => String(item.status).toLowerCase() === 'complete').length,
    canPause: !['COMPLETE', 'FAILED', 'CANCELLED', 'PAUSED'].includes(phase),
    canResume: ['PAUSED', 'CANCELLED'].includes(phase),
    canStop: !['COMPLETE', 'CANCELLED'].includes(phase),
    canReset: ['PAUSED', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(phase),
    canRetry: phase === 'FAILED',
  };
}

function normalizeProjectScene(scene = {}, index = 0) {
  const targetTurns = Math.max(1, Number(scene.targetTurns) || 1);
  const maxTurns = Math.max(targetTurns, Number(scene.maxTurns) || targetTurns);
  return {
    id: text(scene.id, `scene-${index + 1}`),
    index,
    number: index + 1,
    title: text(scene.title, `장면 ${index + 1}`),
    summary: text(scene.summary),
    goal: text(scene.goal),
    opening: text(scene.opening),
    targetTurns,
    maxTurns,
    emotionIntensity: text(scene.emotionIntensity, 'medium'),
    endCondition: text(scene.endCondition),
    transitionText: text(scene.transitionText),
  };
}

export function buildProjectSurfaceModel(projectPlan = null) {
  if (!projectPlan || typeof projectPlan !== 'object') return null;
  const scenes = (Array.isArray(projectPlan.scenes) ? projectPlan.scenes : [])
    .map(normalizeProjectScene);
  const currentSceneIndex = scenes.length
    ? Math.min(Math.max(0, Number(projectPlan.currentSceneIndex) || 0), scenes.length - 1)
    : 0;
  const currentScene = scenes[currentSceneIndex] || null;
  const sceneTurnCount = Math.max(0, Number(projectPlan.sceneTurnCount) || 0);
  const totalExpectedTurns = Number(projectPlan.totalExpectedTurns) || scenes.reduce((sum, scene) => sum + scene.targetTurns, 0);
  const totalMaxTurns = Number(projectPlan.totalMaxTurns) || scenes.reduce((sum, scene) => sum + scene.maxTurns, 0);
  return {
    id: text(projectPlan.id),
    keyword: text(projectPlan.keyword),
    title: text(projectPlan.title, '프로젝트'),
    premise: text(projectPlan.premise),
    status: text(projectPlan.status, 'DRAFT').toUpperCase(),
    sceneCount: scenes.length,
    totalExpectedTurns,
    totalMaxTurns,
    currentSceneIndex,
    sceneTurnCount,
    approval: {
      approved: projectPlan.approval?.approved === true,
      scope: text(projectPlan.approval?.scope, 'all') === 'scene' ? 'scene' : 'all',
      approvedAt: Number(projectPlan.approval?.approvedAt) || null,
    },
    scenes,
    currentScene: currentScene
      ? {
        ...currentScene,
        sceneTurnCount,
        remainingExpectedTurns: Math.max(0, currentScene.targetTurns - sceneTurnCount),
        remainingMaxTurns: Math.max(0, currentScene.maxTurns - sceneTurnCount),
      }
      : null,
  };
}

export function buildYouTubeSurfaceModel(meeting = {}, jobs = []) {
  const statusKey = text(meeting.status, 'READY').toUpperCase();
  const modeKey = meeting.interactionMode === 'autonomous' ? 'autonomous' : 'interactive';
  const characters = (Array.isArray(meeting.participants) ? meeting.participants : [])
    .map(normalizeCharacter);
  const captures = (Array.isArray(jobs) ? jobs : [])
    .map(normalizeCapture)
    .sort((a, b) => a.turnNumber - b.turnNumber || a.key.localeCompare(b.key));
  const actions = {
    canStart: statusKey !== 'LIVE',
    canPause: statusKey === 'LIVE' || statusKey === 'PAUSED',
    canEnd: !['READY', 'FINISHED'].includes(statusKey),
    canChangeMode: ['READY', 'PAUSED'].includes(statusKey),
    canAddCharacter: characters.length < 6,
    needsAttention: statusKey === 'NEEDS_ATTENTION',
  };
  return {
    title: text(meeting.title, '새 쇼츠 장면'),
    topic: text(meeting.topicText),
    status: { key: statusKey, label: sceneStatusLabel(statusKey) },
    mode: { key: modeKey, label: modeKey === 'autonomous' ? '자동 진행' : '직접 진행' },
    characters,
    transcript: Array.isArray(meeting.transcript) ? meeting.transcript : [],
    captures: { counts: captureCounts(captures), items: captures },
    currentTurn: Math.max(0, Number(meeting.currentTurn) || 0),
    project: buildProjectSurfaceModel(meeting.projectPlan),
    autopilot: buildAutopilotSurfaceModel(meeting.autopilotRun, jobs),
    actions,
  };
}
