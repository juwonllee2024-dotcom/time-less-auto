export const AUTOPILOT_STATES = Object.freeze([
  'READY',
  'PLAN_REQUESTED',
  'PLAN_RECEIVED',
  'PLAN_REPAIRING',
  'PLAN_VALIDATED',
  'PLAN_FALLBACK_USED',
  'INJECTING',
  'INJECTION_VERIFIED',
  'RUNNING',
  'WAITING_RESPONSE',
  'CAPTURE_QUEUED',
  'CAPTURE_VERIFIED',
  'TURN_RECORDED',
  'SCENE_TRANSITION',
  'PACKAGING',
  'COMPLETE',
  'PAUSED',
  'FAILED',
  'CANCELLED',
]);

const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);
const PAUSABLE_STATES = new Set(AUTOPILOT_STATES.filter((state) => !TERMINAL_STATES.has(state)));

export function isAutopilotRunActive(run = null) {
  const state = String(run?.state || '').toUpperCase();
  return AUTOPILOT_STATES.includes(state) && !TERMINAL_STATES.has(state);
}

export function assertManualMutationAllowed(run = null, action = 'manual mutation') {
  if (isAutopilotRunActive(run)) {
    throw new Error(`V2 autopilot is active; ${safeText(action, 120) || 'manual mutation'} is locked.`);
  }
  return true;
}

const TRANSITIONS = Object.freeze({
  READY: new Set(['PLAN_REQUESTED', 'FAILED', 'CANCELLED']),
  PLAN_REQUESTED: new Set(['PLAN_RECEIVED', 'PLAN_REPAIRING', 'PLAN_FALLBACK_USED', 'PLAN_VALIDATED', 'PAUSED', 'FAILED', 'CANCELLED']),
  PLAN_RECEIVED: new Set(['PLAN_VALIDATED', 'PLAN_REPAIRING', 'PLAN_FALLBACK_USED', 'FAILED', 'PAUSED', 'CANCELLED']),
  PLAN_REPAIRING: new Set(['PLAN_RECEIVED', 'PLAN_REPAIRING', 'PLAN_VALIDATED', 'PLAN_FALLBACK_USED', 'FAILED', 'PAUSED', 'CANCELLED']),
  PLAN_VALIDATED: new Set(['INJECTING', 'FAILED', 'PAUSED', 'CANCELLED']),
  PLAN_FALLBACK_USED: new Set(['INJECTING', 'FAILED', 'PAUSED', 'CANCELLED']),
  INJECTING: new Set(['INJECTING', 'INJECTION_VERIFIED', 'FAILED', 'PAUSED', 'CANCELLED']),
  INJECTION_VERIFIED: new Set(['RUNNING', 'FAILED', 'PAUSED', 'CANCELLED']),
  RUNNING: new Set(['WAITING_RESPONSE', 'CAPTURE_QUEUED', 'PAUSED', 'FAILED', 'CANCELLED']),
  WAITING_RESPONSE: new Set(['CAPTURE_QUEUED', 'PAUSED', 'FAILED', 'CANCELLED']),
  CAPTURE_QUEUED: new Set(['CAPTURE_VERIFIED', 'PAUSED', 'FAILED', 'CANCELLED']),
  CAPTURE_VERIFIED: new Set(['TURN_RECORDED', 'PAUSED', 'FAILED', 'CANCELLED']),
  TURN_RECORDED: new Set(['SCENE_TRANSITION', 'RUNNING', 'PACKAGING', 'PAUSED', 'FAILED', 'CANCELLED']),
  SCENE_TRANSITION: new Set(['INJECTING', 'RUNNING', 'PACKAGING', 'PAUSED', 'FAILED', 'CANCELLED']),
  PACKAGING: new Set(['COMPLETE', 'FAILED', 'PAUSED', 'CANCELLED']),
  PAUSED: new Set([...PAUSABLE_STATES, 'FAILED', 'CANCELLED']),
  COMPLETE: new Set(),
  FAILED: new Set(['PACKAGING', 'PAUSED', 'CANCELLED']),
  CANCELLED: new Set(),
});

function safeText(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function nowValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeRoleSlots(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((slot = {}, index) => ({
    roleId: safeText(slot.roleId, 80) || `role-${index + 1}`,
    roleIndex: Number.isInteger(Number(slot.roleIndex)) ? Number(slot.roleIndex) : index,
    participantId: safeText(slot.participantId, 160),
    tabId: Number.isInteger(Number(slot.tabId)) ? Number(slot.tabId) : null,
    provider: safeText(slot.provider, 40),
    label: safeText(slot.label, 160),
    role: safeText(slot.role, 240),
    rolePrompt: safeText(slot.rolePrompt || slot.roleGuidance, 500),
  }));
}

function eventKey(event = {}) {
  const metadata = safeObject(event.metadata);
  return safeText(metadata.idempotencyKey || event.idempotencyKey || `${event.type || 'EVENT'}:${event.target || ''}:${event.message || ''}`, 600);
}

function freshMetrics(skeletonPlan = {}) {
  const policy = safeObject(skeletonPlan.runPolicy);
  return {
    expectedTurns: Number.isFinite(Number(policy.expectedTotalTurns)) ? Number(policy.expectedTotalTurns) : 0,
    maxTurns: Number.isFinite(Number(policy.maxTotalTurns)) ? Number(policy.maxTotalTurns) : 0,
    actualTurns: 0,
    successfulCaptures: 0,
    failedCaptures: 0,
    zipFiles: 0,
  };
}

export function createAutopilotRun({ runId, projectBrief, plannerTabId, skeletonPlan = null, bindings = [], roleHints = '', roleSlots = [], now = Date.now() } = {}) {
  const createdAt = nowValue(now);
  const id = safeText(runId, 160) || `run-${createdAt}`;
  const plan = skeletonPlan && typeof skeletonPlan === 'object' ? skeletonPlan : null;
  const run = {
    runId: id,
    projectBrief: safeText(projectBrief, 4000),
    plannerTabId: Number.isInteger(Number(plannerTabId)) ? Number(plannerTabId) : null,
    roleHints: safeText(roleHints, 1800),
    roleSlots: normalizeRoleSlots(roleSlots),
    plan,
    state: 'READY',
    plannerAttempt: 0,
    bindings: Array.isArray(bindings) ? bindings.map((binding) => ({ ...binding })) : [],
    providers: {},
    events: [],
    sequence: 0,
    seen: { packets: {}, turns: {}, captures: {}, zips: {} },
    metrics: freshMetrics(plan || {}),
    currentSceneIndex: 0,
    sceneTurnCount: 0,
    artifactSummary: null,
    createdAt,
    updatedAt: createdAt,
  };
  return appendAutopilotEvent(run, {
    type: 'RUN_CREATED',
    status: 'complete',
    message: 'Autopilot run created with a complete local skeleton.',
    metadata: { idempotencyKey: `run-created:${id}` },
    now: createdAt,
  });
}

export function appendAutopilotEvent(run, event = {}) {
  const source = run && typeof run === 'object' ? run : createAutopilotRun({ projectBrief: '' });
  const key = eventKey(event);
  const existing = (source.events || []).some((item) => item?.idempotencyKey === key);
  if (existing) return source;
  const sequence = Number(source.sequence) || 0;
  const at = nowValue(event.now || Date.now());
  const nextEvent = {
    id: `${source.runId}:event:${sequence + 1}`,
    idempotencyKey: key,
    sequence: sequence + 1,
    type: safeText(event.type, 80) || 'EVENT',
    status: safeText(event.status, 40) || 'info',
    target: safeText(event.target, 160),
    message: safeText(event.message, 1000),
    metadata: safeObject(event.metadata),
    at,
  };
  return { ...source, sequence: sequence + 1, events: [...(source.events || []), nextEvent].slice(-500), updatedAt: at };
}

export function transitionAutopilot(run, nextState, patch = {}, now = Date.now()) {
  const source = run && typeof run === 'object' ? run : null;
  if (!source || !AUTOPILOT_STATES.includes(nextState)) throw new Error(`Invalid autopilot state: ${nextState}.`);
  const current = source.state || 'READY';
  const allowed = TRANSITIONS[current] || new Set();
  if (current !== nextState && !allowed.has(nextState)) throw new Error(`Invalid autopilot transition: ${current} -> ${nextState}.`);
  const at = nowValue(now);
  const next = { ...source, ...safeObject(patch), state: nextState, updatedAt: at };
  return appendAutopilotEvent(next, {
    type: `STATE_${nextState}`,
    status: 'complete',
    message: `${current} -> ${nextState}`,
    metadata: { idempotencyKey: `state:${nextState}:${at}` },
    now: at,
  });
}

export function markAutopilotFailed(run, { error = 'Autopilot failed.', stage = 'AUTOPILOT', now = Date.now() } = {}) {
  const source = run && typeof run === 'object' ? run : null;
  if (!source || TERMINAL_STATES.has(source.state)) return source;
  return transitionAutopilot(source, 'FAILED', {
    failureError: safeText(error, 1000) || 'Autopilot failed.',
    failureStage: safeText(stage, 80) || 'AUTOPILOT',
    failedFrom: source.state || 'READY',
  }, nowValue(now));
}

export function recordPlanAttempt(run, { attempt = 1, outcome = 'pending', errors = [] } = {}) {
  const next = { ...run, plannerAttempt: Math.max(Number(run?.plannerAttempt) || 0, Number(attempt) || 0) };
  return appendAutopilotEvent(next, {
    type: 'PLAN_ATTEMPT',
    status: outcome,
    message: `Plan attempt ${Number(attempt) || 0}: ${safeText(outcome, 80)}.`,
    metadata: { idempotencyKey: `plan-attempt:${Number(attempt) || 0}:${safeText(outcome, 80)}`, errors: Array.isArray(errors) ? errors : [] },
  });
}

export function recordProviderInjection(run, { providerId, roleId = '', sceneIndex = 0, packetId = '', status = 'pending', error = '' } = {}) {
  const id = safeText(providerId, 160) || 'unknown-provider';
  const providers = { ...(run.providers || {}) };
  providers[id] = { ...(providers[id] || {}), providerId: id, roleId: safeText(roleId, 100), sceneIndex: Number(sceneIndex) || 0, packetId: safeText(packetId, 160), injectionStatus: safeText(status, 40), injectionError: safeText(error, 600), updatedAt: Date.now() };
  return appendAutopilotEvent({ ...run, providers }, {
    type: 'PROVIDER_INJECTION',
    status,
    target: id,
    message: error || `Role packet ${packetId || 'pending'} is ${status}.`,
    metadata: { idempotencyKey: `injection:${id}:${packetId}:${status}` },
  });
}

export function recordProviderTurn(run, { providerId, sceneIndex = 0, turnNumber = 0, captureKey = '' } = {}) {
  const id = safeText(providerId, 160) || 'unknown-provider';
  const key = safeText(captureKey, 240) || `turn:${id}:${Number(sceneIndex) || 0}:${Number(turnNumber) || 0}`;
  const seen = { ...((run && run.seen) || {}) , turns: { ...(((run && run.seen) || {}).turns || {}) } };
  if (seen.turns[key]) return run;
  seen.turns[key] = true;
  const metrics = { ...(run.metrics || {}), actualTurns: (Number(run.metrics?.actualTurns) || 0) + 1 };
  const next = { ...run, seen, metrics, currentSceneIndex: Number(sceneIndex) || 0, sceneTurnCount: Number(turnNumber) || 0 };
  return appendAutopilotEvent(next, {
    type: 'PROVIDER_TURN',
    status: 'complete',
    target: id,
    message: `Provider turn ${Number(turnNumber) || 0} recorded.`,
    metadata: { idempotencyKey: `turn:${key}`, sceneIndex, turnNumber, captureKey: key },
  });
}

export function recordCapture(run, { captureKey, status = 'pending', filename = '', error = '' } = {}) {
  const key = safeText(captureKey, 240);
  if (!key) return run;
  const seen = { ...((run && run.seen) || {}), captures: { ...(((run && run.seen) || {}).captures || {}) } };
  const previous = seen.captures[key];
  const nextStatus = safeText(status, 40);
  if (previous?.status === nextStatus && (!filename || previous.filename === filename)) return run;
  seen.captures[key] = { status: nextStatus, filename: safeText(filename, 400), error: safeText(error, 600), updatedAt: Date.now() };
  const metrics = { ...(run.metrics || {}) };
  if (nextStatus === 'complete' && previous?.status !== 'complete') metrics.successfulCaptures = (Number(metrics.successfulCaptures) || 0) + 1;
  if (nextStatus === 'failed' && previous?.status !== 'failed') metrics.failedCaptures = (Number(metrics.failedCaptures) || 0) + 1;
  return appendAutopilotEvent({ ...run, seen, metrics }, {
    type: nextStatus === 'complete' ? 'CAPTURE_VERIFIED' : nextStatus === 'failed' ? 'CAPTURE_FAILED' : 'CAPTURE_QUEUED',
    status: nextStatus,
    target: key,
    message: error || filename || `Capture ${nextStatus}.`,
    metadata: { idempotencyKey: `capture:${key}:${nextStatus}`, filename: safeText(filename, 400) },
  });
}

export function deriveAutopilotMetrics(run = {}) {
  const metrics = run.metrics || {};
  return {
    expectedTurns: Number(metrics.expectedTurns) || 0,
    maxTurns: Number(metrics.maxTurns) || 0,
    actualTurns: Number(metrics.actualTurns) || 0,
    successfulCaptures: Number(metrics.successfulCaptures) || 0,
    failedCaptures: Number(metrics.failedCaptures) || 0,
    zipFiles: Number(metrics.zipFiles) || 0,
  };
}

export function isAutopilotTerminal(state) {
  return TERMINAL_STATES.has(state);
}
