import { classifyUrl, normalizeText, signatureFor, providerLabelFor, isRelayEnvelope, buildCompactRelayPrompt, sanitizeRelayResponse } from './relay-core.mjs';
import {
  createMeeting,
  DEFAULT_MEETING_SETTINGS,
  addParticipant,
  removeParticipant,
  bindParticipant,
  updateParticipant,
  appendTranscript,
  appendActivity,
  setMeetingStatus,
  publicMeetingState,
  durableMeetingState,
  MAX_PARTICIPANTS,
  ensureParticipantSlots,
  resetAutopilotMeeting,
  normalizeInteractionMode,
  normalizeTopicText,
} from './meeting-engine.mjs';
import {
  autonomousSeed,
  canAcceptUserMessage,
  canChangeInteractionMode,
} from './interaction-mode.mjs';
import {
  createTransaction,
  transitionTransaction,
  canAcceptEvent,
  deliveryEvidenceConfirmed,
  shouldRetryTransaction,
  markTransactionRetry,
  transactionTimedOut,
} from './transaction-engine.mjs';
import { selectNextSpeaker } from './router.mjs';
import {
  buildAdaptiveContextPlan,
  buildAutonomousContextPlan,
  buildAutonomousFallbackInlinePrompt,
  buildFallbackInlinePrompt,
} from './context-engine.mjs';
import { createBackgroundTabController } from './background-tab-controller.mjs';
import {
  createLoopGuardState,
  currentSessionPhase,
  loopGuardDecision,
  normalizeMeetingCoordination,
  normalizeParticipantCoordination,
  normalizeSession,
  recordLoopGuardHop,
  recordSessionTurn,
  startSession,
} from './coordination-engine.mjs';
import {
  buildProjectPlan,
  buildLocalSkeletonProjectPlan,
  alignPlanToRoleSlots,
  adaptAiProjectPlan,
  currentProjectScene,
  normalizeProjectPlan,
  recordProjectTurn,
  selectAutopilotParticipants,
} from './project-engine.mjs';
import {
  buildPlanPrompt,
  buildPlanRepairPrompt,
  extractPlanEnvelope,
  planResponseGate,
} from './ai-plan-protocol.mjs';
import { autopilotTabCapacity } from './autopilot-preflight.mjs';
import { aiTabTarget, normalizeRequestedProviders } from './ai-tab-catalog.mjs';
import {
  AUTO_PROVISION_PROVIDER,
  createAutoTabManifest,
  bindAutoRoleSlots,
  normalizeAutoProvisionRequest,
} from './auto-provisioning.mjs';
import {
  AUTOPILOT_STATES,
  appendAutopilotEvent,
  createAutopilotRun,
  deriveAutopilotMetrics,
  recordPlanAttempt,
  recordCapture,
  recordProviderTurn,
  recordProviderInjection,
  markAutopilotFailed,
  assertManualMutationAllowed,
  isAutopilotRunActive,
  transitionAutopilot,
} from './autopilot-engine.mjs';
import { buildRolePacket } from './role-packet.mjs';
import {
  buildSceneTransitionCard,
  currentSceneContract,
} from './scene-contract.mjs';
import {
  artifactZipFilename,
  artifactCompleteness,
  buildManifest,
  buildRunReport,
  screenshotMembersFromJobs,
} from './artifact-store.mjs';
import { buildZipBundle, bytesToBase64, isVerifiedPngData } from './zip-builder.mjs';
import {
  SCREENSHOT_MAX_ATTEMPTS,
  buildScreenshotFilename,
  createScreenshotJob,
  enqueueScreenshotJob,
  markScreenshotJob,
  nextScreenshotJob,
  retryDelayMs,
  validateResponseCapture,
} from './screenshot-capture.mjs';

const ACTIVE_RUNTIME_KEY = 'timeLessAuto2.0.0MeetingRuntime';
const SAVED_MEETING_KEY = 'timeLessAuto2.0.0SavedMeeting';
const LEGACY_ACTIVE_RUNTIME_KEYS = ['timeLessAuto1.0.0MeetingRuntime', 'v4.0.0MeetingRuntime', 'v3.0.8MeetingRuntime'];
const LEGACY_SAVED_MEETING_KEYS = ['timeLessAuto1.0.0SavedMeeting', 'v4.0.0SavedMeeting', 'v3.0.8SavedMeeting'];
const UI_SETTINGS_KEY = 'v3UiSettings';
const WATCHDOG_ALARM = 'time-less-auto-v2.0.0-watchdog';
const AUTOPILOT_PLAN_ALARM = 'time-less-auto-v2.0.0-autopilot-plan';
const SPEAKER_ALARM = 'time-less-auto-v2.0.0-speaker';
const SCREENSHOT_QUEUE_KEY = 'timeLessAuto2.0.0ScreenshotQueue';
const LEGACY_SCREENSHOT_QUEUE_KEYS = ['timeLessAuto1.0.0ScreenshotQueue'];
const SCREENSHOT_RETRY_ALARM = 'time-less-auto-v2.0.0-screenshot-retry';
const ACTIVE_TURN_CHECK_DELAY_MS = 2400;
let activeTurnCheckTimer = null;
let screenshotQueueRun = null;
let autopilotPlanInFlightRunId = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let eventQueue = Promise.resolve();
const backgroundTabController = createBackgroundTabController(chrome);

function enqueue(task) {
  const run = eventQueue.then(task, task);
  eventQueue = run.catch(() => {});
  return run;
}

function withActivity(meeting, message, extra = {}) {
  return appendActivity(meeting, { message, ...extra });
}

function scheduleActiveTurnCheck(delayMs = ACTIVE_TURN_CHECK_DELAY_MS) {
  if (activeTurnCheckTimer) clearTimeout(activeTurnCheckTimer);
  const delay = Math.max(100, Number(delayMs) || ACTIVE_TURN_CHECK_DELAY_MS);
  activeTurnCheckTimer = setTimeout(() => {
    activeTurnCheckTimer = null;
    enqueue(() => watchdogRecover()).catch(() => {});
  }, delay);
}

async function enableSidePanelAction() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

enableSidePanelAction();

async function ensureWatchdog() {
  await chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
}

function scheduleAutopilotPlanAlarm(delayMs = 250) {
  return chrome.alarms.create(AUTOPILOT_PLAN_ALARM, { when: Date.now() + Math.max(100, Number(delayMs) || 250) });
}

function scheduleSpeakerAlarm(at) {
  return chrome.alarms.create(SPEAKER_ALARM, { when: Math.max(Date.now() + 100, Number(at) || Date.now() + 100) });
}

async function clearAutopilotWorkAlarms() {
  await Promise.all([
    chrome.alarms.clear(AUTOPILOT_PLAN_ALARM).catch(() => false),
    chrome.alarms.clear(SPEAKER_ALARM).catch(() => false),
  ]);
}

function sanitizeMeetingTranscript(meeting) {
  if (!meeting?.transcript?.length) return meeting;
  let changed = false;
  const transcript = [];
  for (const entry of meeting.transcript) {
    if (entry.speakerType === 'USER' && isRelayEnvelope(entry.text)) {
      changed = true;
      continue;
    }
    if (entry.speakerType === 'AI') {
      const cleaned = sanitizeRelayResponse(entry.text, '');
      if (!cleaned) {
        changed = true;
        continue;
      }
      if (cleaned !== normalizeText(entry.text)) {
        changed = true;
        transcript.push({ ...entry, text: cleaned });
        continue;
      }
    }
    transcript.push(entry);
  }
  return changed ? { ...meeting, transcript } : meeting;
}

async function getMeeting() {
  const sessionKeys = [ACTIVE_RUNTIME_KEY, ...LEGACY_ACTIVE_RUNTIME_KEYS];
  const session = await chrome.storage.session.get(sessionKeys);
  const activeStored = sessionKeys.map((key) => session[key]).find(Boolean);
  if (activeStored) {
    const active = normalizeMeetingCoordination(sanitizeMeetingTranscript(activeStored));
    const next = {
      ...active,
      settings: { ...DEFAULT_MEETING_SETTINGS, ...(active.settings || {}) },
      interactionMode: normalizeInteractionMode(active.interactionMode),
      topicText: normalizeTopicText(active.topicText),
      projectPlan: normalizeProjectPlan(active.projectPlan),
    };
    if (!session[ACTIVE_RUNTIME_KEY]) await chrome.storage.session.set({ [ACTIVE_RUNTIME_KEY]: next });
    return next;
  }
  const localKeys = [SAVED_MEETING_KEY, ...LEGACY_SAVED_MEETING_KEYS];
  const local = await chrome.storage.local.get(localKeys);
  const stored = localKeys.map((key) => local[key]).find(Boolean);
  const restored = normalizeMeetingCoordination(sanitizeMeetingTranscript(stored || createMeeting()));
  const meeting = normalizeMeetingCoordination({
    ...restored,
    settings: { ...DEFAULT_MEETING_SETTINGS, ...(restored.settings || {}) },
    status: restored.status === 'FINISHED' ? 'FINISHED' : 'READY',
    interactionMode: normalizeInteractionMode(restored.interactionMode),
    topicText: normalizeTopicText(restored.topicText),
    projectPlan: normalizeProjectPlan(restored.projectPlan),
    activeTransaction: null,
    participants: (restored.participants || []).map((p) => ({ ...p, tabId: null, url: '', connectionState: 'DISCONNECTED', turnState: 'WAITING' })),
  });
  await chrome.storage.session.set({ [ACTIVE_RUNTIME_KEY]: meeting });
  if (!local[SAVED_MEETING_KEY] && stored) {
    await chrome.storage.local.set({ [SAVED_MEETING_KEY]: durableMeetingState(meeting) });
  }
  return meeting;
}

async function broadcastMeeting(meeting) {
  await chrome.runtime.sendMessage({ type: 'MEETING_STATE_CHANGED', meeting: publicMeetingState(meeting) }).catch(() => {});
}

async function saveMeeting(meeting, { broadcast = true } = {}) {
  const next = normalizeMeetingCoordination({
    ...meeting,
    updatedAt: Date.now(),
    settings: { ...DEFAULT_MEETING_SETTINGS, ...(meeting.settings || {}) },
    projectPlan: normalizeProjectPlan(meeting.projectPlan),
  });
  await chrome.storage.session.set({ [ACTIVE_RUNTIME_KEY]: next });
  await chrome.storage.local.set({ [SAVED_MEETING_KEY]: durableMeetingState(next) });
  if (broadcast) await broadcastMeeting(next);
  return next;
}

async function loadScreenshotQueue() {
  const keys = [SCREENSHOT_QUEUE_KEY, ...LEGACY_SCREENSHOT_QUEUE_KEYS];
  const stored = await chrome.storage.local.get(keys);
  if (Array.isArray(stored[SCREENSHOT_QUEUE_KEY])) return stored[SCREENSHOT_QUEUE_KEY];
  return keys.slice(1).flatMap((key) => Array.isArray(stored[key]) ? stored[key] : []);
}

async function saveScreenshotQueue(queue) {
  await chrome.storage.local.set({ [SCREENSHOT_QUEUE_KEY]: Array.isArray(queue) ? queue : [] });
}

async function clearScreenshotJobsForMeeting(meetingId) {
  if (!meetingId) return;
  const queue = await loadScreenshotQueue();
  const next = queue.filter((job) => job?.meetingId !== meetingId);
  if (next.length !== queue.length) await saveScreenshotQueue(next);
}

async function recordScreenshotActivity(job, message, level = 'INFO') {
  const meeting = await getMeeting();
  if (!meeting || meeting.id !== job.meetingId) return;
  const next = withActivity(meeting, message, {
    level,
    stage: 'SCREENSHOT_CAPTURE',
    participantId: job.participantId,
    transactionId: job.transactionId,
  });
  await saveMeeting(next);
}

async function syncAutopilotCaptureState(job, status, patch = {}) {
  const meeting = await getMeeting();
  const run = autopilotRunFor(meeting);
  if (!isAutopilotRunActive(run) || meeting.id !== job?.meetingId) return;
  const nextRun = recordCapture(run, {
    captureKey: job.key,
    status,
    filename: patch.filename || job.filename || '',
    error: patch.error || job.error || '',
  });
  if (nextRun === run) return;
  await saveMeeting(withActivity({ ...meeting, autopilotRun: nextRun }, status === 'complete' ? `Capture verified · ${job.filename}` : `Capture ${status} · ${job.filename}`, {
    level: status === 'failed' ? 'WARN' : 'INFO',
    stage: status === 'complete' ? 'CAPTURE_VERIFIED' : 'CAPTURE_QUEUED',
    participantId: job.participantId,
    transactionId: job.transactionId,
  }));
}

function scheduleScreenshotRetry(delayMs) {
  const delay = Math.max(1000, Number(delayMs) || 1000);
  chrome.alarms.create(SCREENSHOT_RETRY_ALARM, { when: Date.now() + delay }).catch(() => {});
}

async function waitForDownloadComplete(downloadId, timeoutMs = 15000) {
  if (!Number.isInteger(downloadId) || !chrome.downloads?.search) return;
  const current = await chrome.downloads.search({ id: downloadId }).catch(() => []);
  if (current?.[0]?.state === 'complete') return;
  if (!chrome.downloads?.onChanged?.addListener) return;
  await new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        cleanup();
        resolve();
      } else if (delta.state?.current === 'interrupted') {
        cleanup();
        reject(new Error(delta.error?.current || 'Screenshot download interrupted.'));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Screenshot download did not complete in time.'));
    }, timeoutMs);
  });
}

async function captureScreenshotJob(job) {
  const participant = {
    id: job.participantId,
    tabId: job.tabId,
    provider: job.provider,
    label: providerLabelFor(job.provider),
  };
  const rectResponse = await sendToParticipant(participant, { type: 'GET_LATEST_RESPONSE_RECT' });
  if (!rectResponse?.ok) throw new Error(rectResponse?.error || 'Response card bounds unavailable.');
  const evidence = validateResponseCapture({
    expectedSignature: job.responseSignature,
    responseSignature: rectResponse.responseSignature,
    responseText: rectResponse.responseText,
    captureKind: rectResponse.captureKind,
    responseId: rectResponse.responseId,
    rect: rectResponse.rect,
  });
  if (!evidence.ok) throw new Error(evidence.error);
  const latestText = normalizeText(evidence.responseText);
  const latestSignature = await signatureFor(latestText);
  if (latestSignature !== job.responseSignature) throw new Error('Latest response changed before screenshot capture.');
  const clip = evidence.clip;

  const target = { tabId: job.tabId };
  const alreadyAttached = backgroundTabController.isAttached(job.tabId);
  let attached = false;
  try {
    if (!alreadyAttached) {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
    }
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip,
    });
    if (!shot?.data) throw new Error('Chrome returned an empty screenshot.');
    if (!isVerifiedPngData(shot.data)) throw new Error('Chrome returned a non-PNG screenshot payload.');
    const filename = job.filename || buildScreenshotFilename({ meetingId: job.meetingId, provider: job.provider, turnNumber: job.turnNumber, timestamp: job.createdAt });
    const downloadId = await chrome.downloads.download({
      url: `data:image/png;base64,${shot.data}`,
      filename,
      saveAs: false,
      conflictAction: 'overwrite',
    });
    await waitForDownloadComplete(downloadId);
    return {
      filename,
      downloadId,
      dataBase64: shot.data,
      verified: true,
      captureKind: evidence.captureKind,
      responseId: evidence.responseId,
      responseSignature: evidence.responseSignature,
    };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

async function processScreenshotQueue() {
  if (screenshotQueueRun) return screenshotQueueRun;
  screenshotQueueRun = (async () => {
    let queue = await loadScreenshotQueue();
    while (true) {
      const job = nextScreenshotJob(queue, Date.now());
      if (!job) {
        const future = queue.find((item) => item?.status === 'retry' && Number(item.nextAttemptAt) > Date.now());
        if (future) scheduleScreenshotRetry(Number(future.nextAttemptAt) - Date.now());
        return;
      }
      const attempts = Number(job.attempts) || 0;
      queue = markScreenshotJob(queue, job.key, { status: 'capturing', error: '' });
      await saveScreenshotQueue(queue);
      try {
        const result = await captureScreenshotJob(job);
        queue = markScreenshotJob(queue, job.key, {
          status: 'complete',
          error: '',
          nextAttemptAt: 0,
          filename: result.filename,
          downloadId: result.downloadId,
          dataBase64: result.dataBase64 || '',
          verified: result.verified === true,
          captureKind: result.captureKind || job.captureKind || '',
          responseId: result.responseId || job.responseId || '',
          responseSignature: result.responseSignature || job.responseSignature || '',
          capturedAt: Date.now(),
        });
        await saveScreenshotQueue(queue);
        await syncAutopilotCaptureState(job, 'complete', result);
        await recordScreenshotActivity(job, `Screenshot captured: ${result.filename}`);
      } catch (error) {
        const nextAttempts = attempts + 1;
        const terminal = nextAttempts >= SCREENSHOT_MAX_ATTEMPTS;
        const patch = terminal
          ? { status: 'failed', attempts: nextAttempts, nextAttemptAt: 0, error: error.message || String(error) }
          : { status: 'retry', attempts: nextAttempts, nextAttemptAt: Date.now() + retryDelayMs(nextAttempts), error: error.message || String(error) };
        queue = markScreenshotJob(queue, job.key, patch);
        await saveScreenshotQueue(queue);
        await syncAutopilotCaptureState(job, patch.status, patch);
        if (terminal) {
          await recordScreenshotActivity(job, `Screenshot failed after ${nextAttempts} attempts: ${patch.error}`, 'WARN');
        } else {
          await recordScreenshotActivity(job, `Screenshot retry ${nextAttempts}/${SCREENSHOT_MAX_ATTEMPTS}: ${patch.error}`, 'WARN');
          scheduleScreenshotRetry(retryDelayMs(nextAttempts));
        }
        return;
      }
      queue = await loadScreenshotQueue();
    }
  })().finally(() => {
    screenshotQueueRun = null;
  });
  return screenshotQueueRun;
}

async function queueScreenshotCapture(meeting, participant, transaction) {
  if (!meeting?.settings?.captureScreenshots || !participant?.tabId || !transaction?.transactionId) return false;
  const candidateRun = autopilotRunFor(meeting);
  const run = isAutopilotRunActive(candidateRun) ? candidateRun : null;
  const scene = currentProjectScene(meeting.projectPlan);
  const role = run?.plan?.roles?.find((item) => normalizeText(item.name || item.id) === normalizeText(participant.role || ''))
    || run?.plan?.roles?.find((item) => normalizeText(item.role || item.label) === normalizeText(participant.role || ''))
    || run?.plan?.roles?.[participant.slotIndex || 0]
    || null;
  const job = createScreenshotJob({
    meetingId: meeting.id,
    transactionId: transaction.transactionId,
    participantId: participant.id,
    tabId: participant.tabId,
    provider: participant.provider,
    turnNumber: transaction.turnNumber,
    responseSignature: transaction.responseSignature,
    version: run ? '2.0.0' : '1.0.0',
    sceneIndex: scene ? scene.index + 1 : 1,
    roleId: role?.id || participant.id,
  });
  const queue = await loadScreenshotQueue();
  const next = enqueueScreenshotJob(queue, job);
  if (next === queue) return queue.find((item) => item.key === job.key) || false;
  await saveScreenshotQueue(next);
  return job;
}

async function newMeeting(options = {}) {
  const current = await getMeeting();
  assertNoActiveAutopilot(current, 'starting a new meeting');
  const meeting = createMeeting({
    title: options.title || 'New AI Meeting',
    interactionMode: options.interactionMode,
    topicText: options.topicText,
    settings: options.settings || {},
    session: options.session || {},
    loopGuard: options.loopGuard || {},
  });
  return saveMeeting(meeting);
}

function applyProjectRoles(meeting, projectPlan, roleSlots = []) {
  let next = meeting;
  for (const [index, role] of (projectPlan?.roles || []).entries()) {
    const configuredParticipantId = roleSlots[index]?.participantId;
    const participant = configuredParticipantId
      ? participantById(next, configuredParticipantId)
      : next.participants[index];
    if (!participant) break;
    const patch = {};
    if (!normalizeText(participant.role)) patch.role = role.role || role.label;
    if (!normalizeText(participant.rolePrompt)) patch.rolePrompt = role.rolePrompt || '';
    if (Object.keys(patch).length) next = updateParticipant(next, participant.id, patch);
  }
  return next;
}

function configuredRoleSlots(meeting, basePlan) {
  return selectAutopilotParticipants(meeting, basePlan).map((participant, index) => {
    const fallback = basePlan?.roles?.[index] || {};
    return {
      roleId: fallback.id || `role-${index + 1}`,
      roleIndex: index,
      participantId: participant.id,
      tabId: Number.isInteger(participant.tabId) ? participant.tabId : null,
      provider: participant.provider || '',
      label: participant.label || '',
      role: normalizeText(participant.role || ''),
      rolePrompt: normalizeText(participant.rolePrompt || ''),
    };
  });
}

function roleHintsForSlots(roleSlots = []) {
  return roleSlots.map((slot, index) => [
    `ROLE_SLOT_${index + 1} id=${slot.roleId}`,
    `role=${slot.role || '(AI may name this slot)'}`,
    `guidance=${slot.rolePrompt || '(AI may complete guidance)'}`,
  ].join('; ')).join('\n');
}

async function buildProjectRun(keyword) {
  let meeting = await getMeeting();
  assertNoActiveAutopilot(meeting, 'building a project plan');
  if (meeting.status === 'LIVE' || meeting.activeTransaction) {
    throw new Error('Pause the meeting and finish the active turn before building a project plan.');
  }
  const baseProjectPlan = buildProjectPlan(keyword);
  meeting = ensureParticipantSlots(meeting, Math.max(2, meeting.participants?.length || 0, baseProjectPlan.roles.length));
  const roleSlots = configuredRoleSlots(meeting, baseProjectPlan);
  const projectPlan = alignPlanToRoleSlots(baseProjectPlan, roleSlots);
  const firstScene = currentProjectScene(projectPlan);
  await clearScreenshotJobsForMeeting(meeting.id);
  meeting = {
    ...meeting,
    status: 'READY',
    projectPlan,
    autopilotRun: null,
    artifactSummary: null,
    interactionMode: projectPlan.defaults.interactionMode,
    topicText: firstScene?.opening || projectPlan.premise,
    currentTurn: 0,
    sceneTurnCount: 0,
    transcript: [],
    activeTransaction: null,
    nextSpeakerParticipantId: null,
    session: {},
    settings: {
      ...meeting.settings,
      maxTurns: projectPlan.totalMaxTurns,
      minDelayMs: projectPlan.defaults.minDelayMs,
      captureScreenshots: projectPlan.defaults.captureScreenshots,
      retryLimit: projectPlan.defaults.retryLimit,
    },
    loopGuard: createLoopGuardState(meeting.loopGuard),
  };
  meeting = applyProjectRoles(meeting, projectPlan, roleSlots);
  meeting = withActivity(meeting, `Project plan built: ${projectPlan.title}.`, { stage: 'PROJECT_PLAN' });
  return saveMeeting(meeting);
}

async function approveProjectRun(scope = 'all') {
  let meeting = await getMeeting();
  assertNoActiveAutopilot(meeting, 'approving a project plan');
  if (!meeting.projectPlan) throw new Error('Build a project plan before approving the run.');
  if (meeting.status === 'LIVE' || meeting.activeTransaction) throw new Error('Pause the meeting and finish the active turn before approving a project run.');
  const projectPlan = normalizeProjectPlan({
    ...meeting.projectPlan,
    status: 'APPROVED',
    approval: { approved: true, approvedAt: Date.now(), scope: scope === 'scene' ? 'scene' : 'all' },
  });
  meeting = withActivity({ ...meeting, projectPlan }, 'Project run approved by user.', { stage: 'PROJECT_APPROVAL' });
  return saveMeeting(meeting);
}

function invalidateProjectApproval(meeting) {
  if (!meeting?.projectPlan?.approval?.approved) return meeting;
  return {
    ...meeting,
    projectPlan: normalizeProjectPlan({
      ...meeting.projectPlan,
      status: 'DRAFT',
      approval: { approved: false, approvedAt: null, scope: 'all' },
    }),
  };
}

function participantForTab(meeting, tabId) {
  return meeting.participants.find((p) => p.tabId === tabId) || null;
}

function participantById(meeting, id) {
  return meeting.participants.find((p) => p.id === id) || null;
}

function labelForTab(tab, provider) {
  const title = String(tab.title || '').replace(/\s+/g, ' ').trim();
  return title ? `${providerLabelFor(provider)} — ${title.slice(0, 54)}` : providerLabelFor(provider);
}

async function listSupportedTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => {
    const provider = classifyUrl(tab.url || '');
    if (!provider) return null;
    return {
      tabId: tab.id,
      provider,
      providerLabel: providerLabelFor(provider),
      label: labelForTab(tab, provider),
      title: tab.title || '',
      url: tab.url || '',
      active: Boolean(tab.active),
      windowId: tab.windowId,
    };
  }).filter(Boolean);
}

async function openFreshAiTab(provider = AUTO_PROVISION_PROVIDER, context = {}) {
  const target = aiTabTarget(provider);
  const tab = await chrome.tabs.create({ url: target.url, active: context.active === true });
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId)) throw new Error(`${target.label} tab could not be created.`);
  return {
    tabId,
    provider,
    providerLabel: target.label,
    label: labelForTab(tab, provider),
    title: tab.title || '',
    url: tab.url || target.url,
    active: Boolean(tab.active),
    windowId: tab.windowId,
    reused: false,
    runId: String(context.runId || ''),
    tabKind: context.kind || 'role',
    roleIndex: Number.isInteger(Number(context.roleIndex)) ? Number(context.roleIndex) : null,
  };
}

async function runOwnedAiTab(tabId, expectedProvider = AUTO_PROVISION_PROVIDER) {
  const rawTabId = String(tabId ?? '').trim();
  const id = Number(rawTabId);
  if (!rawTabId || !Number.isInteger(id) || id <= 0) return null;
  const tab = await chrome.tabs.get(id).catch(() => null);
  const provider = classifyUrl(tab?.url || '');
  if (!tab || provider !== expectedProvider) return null;
  return {
    tabId: id,
    provider,
    providerLabel: providerLabelFor(provider),
    label: labelForTab(tab, provider),
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    windowId: tab.windowId,
    reused: true,
  };
}

async function openAiTabs(message = {}) {
  const providers = normalizeRequestedProviders(message.providers);
  if (!providers.length) throw new Error('Choose at least one AI to open.');
  const existing = await listSupportedTabs();
  const meeting = await getMeeting();
  const boundTabIds = new Set(meeting.participants.map((participant) => participant.tabId).filter(Number.isInteger));
  const opened = [];
  const errors = [];

  for (const provider of providers) {
    const target = aiTabTarget(provider);
    // Existing provider tabs can contain unrelated instructions and history.
    // V2 opens a fresh conversation by default; reuse is explicit only.
    const reusable = message.reuseExisting === true
      ? existing.find((tab) => tab.provider === provider && !boundTabIds.has(tab.tabId))
      : null;
    if (reusable) {
      opened.push({ ...reusable, reused: true });
      continue;
    }
    try {
      const tab = await chrome.tabs.create({ url: target.url, active: message.active === true });
      opened.push({
        tabId: tab.id,
        provider,
        providerLabel: target.label,
        label: labelForTab(tab, provider),
        title: tab.title || '',
        url: tab.url || target.url,
        active: Boolean(tab.active),
        windowId: tab.windowId,
        reused: false,
      });
    } catch (error) {
      errors.push(`${target.label}: ${error?.message || String(error)}`);
    }
  }

  if (!opened.length) throw new Error(errors.join(' · ') || 'No AI tab could be opened.');

  let nextMeeting = meeting;
  if (['READY', 'PAUSED', 'NEEDS_ATTENTION'].includes(meeting.status) && !meeting.activeTransaction) {
    const replaceBindings = message.reuseExisting !== true && message.replaceBindings !== false;
    if (replaceBindings) {
      nextMeeting = {
        ...nextMeeting,
        participants: nextMeeting.participants.map((participant) => Number.isInteger(participant.tabId)
          ? { ...participant, tabId: null, provider: null, url: '', connectionState: 'DISCONNECTED', turnState: 'WAITING', lastSeenAt: 0 }
          : participant),
      };
    }
    const unboundCount = nextMeeting.participants.filter((participant) => !Number.isInteger(participant.tabId)).length;
    const additionalSlots = Math.max(0, opened.length - unboundCount);
    const desiredSlots = Math.min(MAX_PARTICIPANTS, nextMeeting.participants.length + additionalSlots);
    while (nextMeeting.participants.length < desiredSlots) {
      nextMeeting = addParticipant(nextMeeting);
    }
    const availableParticipants = nextMeeting.participants.filter((participant) => !Number.isInteger(participant.tabId));
    let participantIndex = 0;
    for (const tab of opened) {
      const participant = availableParticipants[participantIndex];
      if (!participant || !Number.isInteger(tab.tabId)) continue;
      try {
        nextMeeting = bindParticipant(nextMeeting, participant.id, {
          tabId: tab.tabId,
          provider: tab.provider,
          label: tab.providerLabel || providerLabelFor(tab.provider),
          url: tab.url || '',
          connectionState: 'RECONNECTING',
        });
        tab.participantId = participant.id;
        participantIndex += 1;
      } catch (error) {
        errors.push(`${tab.providerLabel || tab.provider}: ${error?.message || String(error)}`);
      }
    }
    // A paused/ready run may already have a role contract. Keep that contract
    // pointed at the newly selected tabs after replacement; otherwise resume
    // could silently send packets to the old conversation history.
    if (nextMeeting.autopilotRun && Array.isArray(nextMeeting.autopilotRun.roleSlots)) {
      const roleSlotCount = nextMeeting.autopilotRun.roleSlots.length;
      const roleSlots = nextMeeting.participants.slice(0, roleSlotCount).map((participant, index) => ({
        ...(nextMeeting.autopilotRun.roleSlots[index] || {}),
        participantId: participant.id,
        tabId: Number.isInteger(participant.tabId) ? participant.tabId : null,
        provider: participant.provider || '',
        label: participant.label || '',
      }));
      const bindings = roleSlots.map((slot, index) => ({
        ...(nextMeeting.autopilotRun.bindings?.[index] || {}),
        participantId: slot.participantId,
        roleId: slot.roleId || `role-${index + 1}`,
        roleIndex: index,
        tabId: slot.tabId,
        provider: slot.provider,
      }));
      nextMeeting = {
        ...nextMeeting,
        autopilotRun: { ...nextMeeting.autopilotRun, roleSlots, bindings },
      };
    }
  }

  const summary = opened.map((tab) => `${tab.providerLabel || providerLabelFor(tab.provider)} ${tab.reused ? 'reused' : 'opened'}`).join(', ');
  nextMeeting = withActivity(nextMeeting, `AI tabs ready: ${summary}.`, { stage: 'AI_TABS_OPENED' });
  const saved = await saveMeeting(nextMeeting);
  return { ok: true, tabs: opened, errors, meeting: saved };
}

async function ensureContent(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (pong?.ok && pong?.runtime === 'TIME_LESS_AUTO_V2') return pong;
    } catch (error) {
      lastError = error;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await sleep(160);
      const injected = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (injected?.ok && injected?.runtime === 'TIME_LESS_AUTO_V2') return injected;
    } catch (error) {
      lastError = error;
    }
    await sleep(280);
  }
  throw lastError || new Error('V2 content runtime is not ready.');
}

async function sendToParticipant(participant, message) {
  if (!Number.isInteger(participant?.tabId)) throw new Error(`${participant?.label || 'Participant'} has no bound tab.`);
  const background = await backgroundTabController.ensure(participant).catch((error) => ({ ok: false, error: error?.message || String(error) }));
  if (background?.error) console.warn(`[Time Less Auto] ${background.error}`);
  const runtimeReady = await ensureContent(participant.tabId);
  if (!runtimeReady?.ok || runtimeReady?.runtime !== 'TIME_LESS_AUTO_V2') {
    throw new Error(`${participant.label || 'Participant'} V2 content runtime is unavailable. Refresh the AI tab and try again.`);
  }
  return chrome.tabs.sendMessage(participant.tabId, message);
}

async function attachParticipant(meeting, participantId) {
  let participant = participantById(meeting, participantId);
  if (!participant || !Number.isInteger(participant.tabId)) throw new Error('Participant is not bound to an AI tab.');
  const tab = await chrome.tabs.get(participant.tabId).catch(() => null);
  if (!tab) throw new Error(`${participant.label} tab is closed.`);
  const provider = classifyUrl(tab.url || '');
  if (!provider) throw new Error(`${participant.label} tab is not currently on a supported AI site.`);
  const response = await sendToParticipant(participant, { type: 'ATTACH_PARTICIPANT', meetingId: meeting.id, participantId: participant.id });
  if (!response?.ok) throw new Error(response?.error || 'Content script attachment failed.');
  meeting = updateParticipant(meeting, participant.id, {
    provider,
    label: participant.label?.startsWith('AI ') ? providerLabelFor(provider) : participant.label,
    url: tab.url || '',
    connectionState: 'READY',
    lastSeenAt: Date.now(),
  });
  return meeting;
}

function latestTranscriptText(meeting) {
  return [...(meeting.transcript || [])].reverse().find((e) => normalizeText(e.text))?.text || '';
}

function meetingContextEntries(meeting) {
  const entries = [];
  for (const entry of meeting.transcript || []) {
    if (entry.speakerType === 'USER' && isRelayEnvelope(entry.text)) continue;
    if (meeting.interactionMode === 'autonomous' && !['AI', 'SYSTEM'].includes(entry.speakerType)) continue;
    const cleanedText = entry.speakerType === 'AI'
      ? sanitizeRelayResponse(entry.text, '')
      : normalizeText(entry.text);
    if (!cleanedText) continue;
    const speaker = entry.kind === 'SCENE_TRANSITION' || entry.speakerType === 'SYSTEM'
      ? 'Scene Director'
      : entry.speakerType === 'USER'
      ? 'User'
      : (participantById(meeting, entry.participantId)?.label || entry.provider || entry.speakerType);
    entries.push({ speaker, text: cleanedText });
  }
  return entries;
}

function buildMeetingContextPlan(meeting, target, entries = meetingContextEntries(meeting)) {
  const phase = meeting.session?.status === 'COMPLETE' ? null : currentSessionPhase(meeting.session);
  const options = {
    provider: target.provider,
    meetingTitle: meeting.title,
    targetLabel: target.label,
    participants: meeting.participants.map((p) => p.label),
    turnNumber: meeting.currentTurn + 1,
    topicText: meeting.topicText,
    role: target.role,
    rolePrompt: target.rolePrompt,
    sessionPhase: phase,
    sceneContract: currentSceneContract(meeting.projectPlan, meeting.interactionMode),
    entries,
  };
  return meeting.interactionMode === 'autonomous'
    ? buildAutonomousContextPlan(options)
    : buildAdaptiveContextPlan(options);
}

function buildMeetingPrompt(meeting, target) {
  return buildMeetingContextPlan(meeting, target).promptText;
}

function buildFallbackPrompt(meeting, participant, entries) {
  const phase = meeting.session?.status === 'COMPLETE' ? null : currentSessionPhase(meeting.session);
  const options = {
    provider: participant.provider,
    targetLabel: participant.label,
    participants: meeting.participants.map((p) => p.label),
    topicText: meeting.topicText,
    role: participant.role,
    rolePrompt: participant.rolePrompt,
    sessionPhase: phase,
    sceneContract: currentSceneContract(meeting.projectPlan, meeting.interactionMode),
    entries,
  };
  return meeting.interactionMode === 'autonomous'
    ? buildAutonomousFallbackInlinePrompt(options)
    : buildFallbackInlinePrompt(options);
}

function setParticipantTurnStates(meeting, activeId, activeState) {
  let next = meeting;
  for (const p of meeting.participants) {
    const state = p.id === activeId ? activeState : (Number.isInteger(p.tabId) ? 'LISTENING' : 'WAITING');
    next = updateParticipant(next, p.id, { turnState: state });
  }
  return next;
}

async function enterNeedsAttention(meeting, reason, stage = null) {
  const tx = meeting.activeTransaction;
  let next = meeting;
  if (tx) next = { ...next, activeTransaction: { ...tx, stage: 'NEEDS_ATTENTION', error: String(reason || 'Unknown failure'), updatedAt: Date.now(), lastProgressAt: Date.now() } };
  next = setMeetingStatus(next, 'NEEDS_ATTENTION');
  if (tx?.participantId) next = updateParticipant(next, tx.participantId, { turnState: 'ERROR', connectionState: participantById(next, tx.participantId)?.connectionState || 'ERROR' });
  next = withActivity(next, reason, { level: 'WARN', stage: stage || tx?.stage || null, participantId: tx?.participantId || null, transactionId: tx?.transactionId || null });
  return saveMeeting(next);
}

async function armResponse(meeting, participant, tx) {
  const response = await sendToParticipant(participant, {
    type: 'ARM_RESPONSE_OBSERVER',
    meetingId: meeting.id,
    transactionId: tx.transactionId,
    participantId: participant.id,
    baselineAssistantSignature: tx.preAssistantSignature || null,
  });
  if (!response?.ok) throw new Error(response?.error || 'Failed to arm response observer.');
  // Do not rely on provider-page timers alone. Hidden Gemini/Copilot tabs can
  // throttle them, so the extension service worker schedules a near-term status
  // verification as an independent second wake-up path.
  scheduleActiveTurnCheck();
}

async function confirmDelivery(meeting, tx, evidence) {
  let nextTx = transitionTransaction(tx, 'DELIVERED', { deliveryEvidence: evidence, error: '' });
  nextTx = transitionTransaction(nextTx, 'WAITING_FOR_GENERATION');
  let next = { ...meeting, activeTransaction: nextTx };
  next = updateParticipant(next, tx.participantId, { turnState: 'THINKING', lastKnownUserSignature: evidence.userSignature || tx.promptSignature });
  next = withActivity(next, 'Delivery confirmed', { stage: 'DELIVERED', participantId: tx.participantId, transactionId: tx.transactionId });
  next = await saveMeeting(next);
  const participant = participantById(next, tx.participantId);
  await armResponse(next, participant, nextTx);
  return next;
}

async function ensurePreparedOnPage(meeting, participant, tx, { captureBaseline = false } = {}) {
  await sendToParticipant(participant, { type: 'ATTACH_PARTICIPANT', meetingId: meeting.id, participantId: participant.id });
  const restore = !captureBaseline && tx.baselineCaptured;
  const response = await sendToParticipant(participant, {
    type: 'PREPARE_DELIVERY',
    meetingId: meeting.id,
    transactionId: tx.transactionId,
    participantId: participant.id,
    text: tx.promptText,
    promptSignature: tx.promptSignature,
    baselineCaptured: Boolean(restore),
    ...(restore ? {
      baselineAssistantSignature: tx.preAssistantSignature ?? null,
      baselineAssistantCount: Number(tx.preAssistantCount) || 0,
      baselineUserSignature: tx.preUserSignature ?? null,
      baselineUserCount: Number(tx.preUserCount) || 0,
      baselineGenerating: Boolean(tx.preGenerating),
      baselineUrl: tx.preUrl || '',
    } : {}),
  });
  if (!response?.ok) throw new Error(response?.error || 'Failed to prepare delivery.');
  return response;
}

async function verifyDelivery(meeting, participant, tx, timeoutMs = 4500) {
  let response;
  try {
    response = await sendToParticipant(participant, {
      type: 'VERIFY_DELIVERY',
      meetingId: meeting.id,
      transactionId: tx.transactionId,
      participantId: participant.id,
      timeoutMs,
    });
  } catch (error) {
    await ensurePreparedOnPage(meeting, participant, tx, { captureBaseline: false });
    response = await sendToParticipant(participant, {
      type: 'VERIFY_DELIVERY', meetingId: meeting.id, transactionId: tx.transactionId, participantId: participant.id, timeoutMs,
    });
  }
  return response?.ok ? response : { matchingUserMessage: false, error: response?.error || 'Verification failed' };
}

async function deliveryWithRetries(meetingId) {
  let meeting = await getMeeting();
  if (meeting.id !== meetingId || !meeting.activeTransaction) return meeting;
  let tx = meeting.activeTransaction;
  const participant = participantById(meeting, tx.participantId);
  if (!participant) return enterNeedsAttention(meeting, 'Target participant no longer exists.', tx.stage);

  // Once a send action has happened, Time Less Auto uses at-most-once delivery.
  // Provider DOM verification is fallible; automatically clicking Send again
  // can create the exact duplicate turns seen on Gemini. Retries below are
  // re-verification attempts only. A human may explicitly request a retry.
  while (true) {
    const evidence = await verifyDelivery(meeting, participant, tx, tx.attempt === 0 ? 7000 : 3000)
      .catch(() => ({ matchingUserMessage: false }));
    const enriched = {
      ...evidence,
      sendActionExecuted: Boolean(tx.sendActionExecuted),
      inputPrimed: Boolean(tx.inputPrimed || evidence.inputPrimed),
    };
    if (deliveryEvidenceConfirmed(enriched)) return confirmDelivery(meeting, tx, enriched);

    if (!shouldRetryTransaction(tx)) {
      return enterNeedsAttention(meeting, `${participant.label} delivery verification stayed inconclusive. Time Less Auto did not resend automatically, to prevent a duplicate message.`, 'VERIFYING_DELIVERY');
    }

    tx = markTransactionRetry(tx, 'Delivery verification inconclusive; re-verifying without resending');
    meeting = { ...meeting, activeTransaction: tx };
    meeting = withActivity(meeting, `Delivery verification inconclusive · re-verify ${tx.attempt}/${tx.retryLimit} (no resend)`, { level: 'WARN', stage: 'RETRYING', participantId: tx.participantId, transactionId: tx.transactionId });
    meeting = await saveMeeting(meeting);
  }
}

async function executeTurn(participantId) {
  let meeting = await getMeeting();
  if (meeting.status !== 'LIVE' || meeting.activeTransaction) return meeting;
  let participant = participantById(meeting, participantId);
  if (!participant || !Number.isInteger(participant.tabId)) return enterNeedsAttention(meeting, 'Next speaker is not connected.');
  if (meeting.settings.maxTurns > 0 && meeting.currentTurn >= meeting.settings.maxTurns) {
    meeting = setMeetingStatus(meeting, 'FINISHED');
    meeting = withActivity(meeting, 'Meeting reached the maximum completed AI turns.');
    return saveMeeting(meeting);
  }

  const contextEntries = meetingContextEntries(meeting);
  let contextPlan = buildMeetingContextPlan(meeting, participant, contextEntries);
  let promptText = contextPlan.promptText;
  let promptSignature = await signatureFor(promptText);
  let tx = createTransaction({
    meetingId: meeting.id,
    participantId: participant.id,
    tabId: participant.tabId,
    turnNumber: meeting.currentTurn + 1,
    promptText,
    promptSignature,
    retryLimit: meeting.settings.retryLimit,
    responseTimeoutMs: meeting.settings.responseTimeoutMs,
    contextMode: contextPlan.mode,
    contextFileName: contextPlan.contextFile?.name || '',
  });
  meeting = { ...meeting, activeTransaction: tx, nextSpeakerParticipantId: participant.id, nextSpeakerAt: null };
  meeting = setParticipantTurnStates(meeting, participant.id, 'SENDING');
  meeting = withActivity(meeting, `Turn ${tx.turnNumber} prepared → ${participant.label} · context ${contextPlan.mode.toUpperCase()}`, { stage: 'PREPARING', participantId: participant.id, transactionId: tx.transactionId });
  const activeAutopilot = autopilotRunFor(meeting);
  if (activeAutopilot && ['RUNNING', 'TURN_RECORDED'].includes(activeAutopilot.state)) {
    meeting = { ...meeting, autopilotRun: transitionAutopilot(activeAutopilot, 'WAITING_RESPONSE', { waitingTurn: tx.turnNumber }) };
  }
  meeting = await saveMeeting(meeting);

  try {
    meeting = await attachParticipant(meeting, participant.id);
    participant = participantById(meeting, participant.id);
    tx = meeting.activeTransaction;
    const baseline = await ensurePreparedOnPage(meeting, participant, tx, { captureBaseline: true });
    if (baseline.generating) throw new Error(`${participant.label} is already generating a response. Wait for it to finish before starting this turn.`);
    tx = {
      ...tx,
      preAssistantSignature: baseline.assistantSignature || null,
      preAssistantCount: Number(baseline.assistantCount) || 0,
      preUserSignature: baseline.userSignature || null,
      preUserCount: Number(baseline.userCount) || 0,
      preGenerating: Boolean(baseline.generating),
      preUrl: baseline.url || '',
      baselineCaptured: true,
    };
    meeting = { ...meeting, activeTransaction: tx };
    meeting = await saveMeeting(meeting);

    if (contextPlan.mode === 'file' && contextPlan.contextFile) {
      const attachmentResult = await sendToParticipant(participant, {
        type: 'ATTACH_CONTEXT_FILE',
        meetingId: meeting.id,
        transactionId: tx.transactionId,
        participantId: participant.id,
        fileName: contextPlan.contextFile.name,
        fileText: contextPlan.contextFile.text,
        mimeType: contextPlan.contextFile.mimeType,
      }).catch((error) => ({ ok: false, attached: false, error: error.message || String(error) }));

      if (!attachmentResult?.ok || !attachmentResult.attached) {
        promptText = buildFallbackPrompt(meeting, participant, contextEntries);
        promptSignature = await signatureFor(promptText);
        contextPlan = { ...contextPlan, mode: 'fallback-inline', promptText, contextFile: null };
        tx = {
          ...tx,
          promptText,
          promptSignature,
          contextMode: 'fallback-inline',
          contextFileName: '',
          contextAttachmentConfirmed: false,
        };
        meeting = { ...meeting, activeTransaction: tx };
        meeting = withActivity(meeting, `Context file unavailable for ${participant.label}; using bounded inline fallback (${promptText.length} chars).`, { level: 'WARN', stage: 'PREPARING', participantId: participant.id, transactionId: tx.transactionId });
        meeting = await saveMeeting(meeting);
        await ensurePreparedOnPage(meeting, participant, tx, { captureBaseline: false });
      } else {
        tx = {
          ...tx,
          contextAttachmentConfirmed: Boolean(attachmentResult.confirmed),
          contextFileName: attachmentResult.fileName || contextPlan.contextFile.name,
        };
        meeting = { ...meeting, activeTransaction: tx };
        meeting = withActivity(meeting, `Context file attached → ${tx.contextFileName} (${contextPlan.contextFile.text.length} chars)`, { stage: 'PREPARING', participantId: participant.id, transactionId: tx.transactionId });
        meeting = await saveMeeting(meeting);
      }
    } else if (contextPlan.mode === 'compact') {
      meeting = withActivity(meeting, `Context compacted for ${participant.label} (${promptText.length} chars).`, { stage: 'PREPARING', participantId: participant.id, transactionId: tx.transactionId });
      meeting = await saveMeeting(meeting);
    }

    tx = transitionTransaction(tx, 'SENDING');
    meeting = { ...meeting, activeTransaction: tx };
    meeting = await saveMeeting(meeting);

    const sent = await sendToParticipant(participant, {
      type: 'SUBMIT_MESSAGE', meetingId: meeting.id, transactionId: tx.transactionId, participantId: participant.id, text: promptText,
    });
    if (!sent?.ok || !sent.sendActionExecuted) throw new Error(sent?.error || 'Send action failed.');
    tx = { ...tx, sendActionExecuted: true, inputPrimed: Boolean(sent.inputPrimed) };

    tx = transitionTransaction(tx, 'VERIFYING_DELIVERY');
    meeting = { ...meeting, activeTransaction: tx };
    meeting = updateParticipant(meeting, participant.id, { turnState: 'VERIFYING' });
    meeting = withActivity(meeting, 'Send action executed; waiting for delivery receipt', { stage: 'VERIFYING_DELIVERY', participantId: participant.id, transactionId: tx.transactionId });
    meeting = await saveMeeting(meeting);
    return deliveryWithRetries(meeting.id);
  } catch (error) {
    return enterNeedsAttention(await getMeeting(), `${participant.label}: ${error.message || String(error)}`, tx.stage);
  }
}

function loopGuardActive(meeting) {
  if (meeting.interactionMode === 'autonomous') return meeting.settings?.loopGuardEnabled !== false;
  return meeting.settings?.loopGuardInteractive === true;
}

function loopGuardSettings(meeting) {
  return {
    enabled: loopGuardActive(meeting),
    maxHops: meeting.settings?.loopGuardMaxHops,
    maxSameSpeaker: meeting.settings?.loopGuardMaxSameSpeaker,
    maxSameRoute: meeting.settings?.loopGuardMaxSameRoute,
  };
}

async function scheduleSpeaker(meeting, latestText, currentParticipantId = null, delayMs = null) {
  if (meeting.status !== 'LIVE' || meeting.activeTransaction) return null;
  const target = selectNextSpeaker(meeting, latestText, currentParticipantId);
  if (!target) return null;
  let next = meeting;
  if (currentParticipantId && loopGuardActive(meeting)) {
    const state = recordLoopGuardHop(meeting.loopGuard, { speakerId: currentParticipantId, targetId: target.id });
    const decision = loopGuardDecision(state, loopGuardSettings(meeting));
    next = { ...meeting, loopGuard: decision.state };
    if (decision.blocked) {
      next = setMeetingStatus({ ...next, activeTransaction: null, nextSpeakerParticipantId: null }, 'PAUSED');
      next = withActivity(next, decision.reason, { level: 'WARN', stage: 'LOOP_GUARD', participantId: target.id });
      await backgroundTabController.releaseAll().catch(() => {});
      await saveMeeting(next);
      return null;
    }
    await saveMeeting(next);
  }
  const delay = delayMs == null ? Math.max(0, Number(meeting.settings.minDelayMs) || 0) : delayMs;
  const nextSpeakerAt = Date.now() + delay;
  const scheduled = {
    ...next,
    nextSpeakerParticipantId: target.id,
    nextSpeakerAt,
  };
  await saveMeeting(scheduled);
  await scheduleSpeakerAlarm(nextSpeakerAt).catch(() => {});
  // Keep the low-latency path while the worker is awake. The alarm above is
  // the durable recovery path when Chrome suspends the service worker.
  setTimeout(() => enqueue(() => executeTurn(target.id)).catch(() => {}), delay);
  return target;
}

async function startMeeting(seedText = '', requestedMode = null) {
  let meeting = await getMeeting();
  assertNoActiveAutopilot(meeting, 'starting a manual meeting');
  if (meeting.status === 'LIVE') return meeting;
  if (meeting.projectPlan && meeting.projectPlan.approval.approved !== true) {
    throw new Error('Project plan requires explicit approval before starting.');
  }
  if (meeting.status === 'READY' && meeting.activeTransaction) {
    meeting = { ...meeting, activeTransaction: null, nextSpeakerParticipantId: null };
  }
  const interactionMode = normalizeInteractionMode(requestedMode ?? meeting.interactionMode);
  meeting = { ...meeting, interactionMode };
  const connected = meeting.participants.filter((p) => Number.isInteger(p.tabId));
  if (connected.length < 2) throw new Error('Connect at least two AI participants before starting.');
  for (const p of connected) {
    try { meeting = await attachParticipant(meeting, p.id); }
    catch (error) { meeting = updateParticipant(meeting, p.id, { connectionState: 'ERROR', turnState: 'ERROR' }); }
  }
  const ready = meeting.participants.filter((p) => Number.isInteger(p.tabId) && p.connectionState === 'READY');
  if (ready.length < 2) {
    meeting = setMeetingStatus(meeting, 'READY');
    meeting = withActivity(meeting, `Only ${ready.length} participant(s) could reconnect. At least two are required.`, { level: 'WARN' });
    await saveMeeting(meeting);
    throw new Error('At least two AI participants must reconnect successfully before starting.');
  }
  const normalizedSeed = normalizeText(seedText);
  if (normalizedSeed && isRelayEnvelope(normalizedSeed)) throw new Error('Time Less Auto internal meeting envelopes cannot be used as a human starting topic.');
  const projectOpening = currentProjectScene(meeting.projectPlan)?.opening || meeting.projectPlan?.premise || '';
  if (interactionMode === 'autonomous') {
    const topicText = autonomousSeed({ meeting, seedText: normalizedSeed || projectOpening });
    if (!topicText) throw new Error('Write a starting topic before starting Full Auto.');
    meeting = { ...meeting, topicText };
  } else {
    const latestUserText = normalizeText([...meeting.transcript].reverse().find((entry) => entry.speakerType === 'USER' && normalizeText(entry.text))?.text || '');
    const interactiveSeed = normalizedSeed || projectOpening;
    if (interactiveSeed && interactiveSeed !== latestUserText) {
      meeting = appendTranscript(meeting, { speakerType: 'USER', text: interactiveSeed, turnNumber: meeting.currentTurn });
    }
    if (!meeting.transcript.some((e) => normalizeText(e.text))) throw new Error('Write a starting topic before starting the meeting.');
  }
  meeting = {
    ...meeting,
    session: startSession(meeting.session),
    loopGuard: createLoopGuardState(meeting.loopGuard),
    ...(meeting.projectPlan ? {
      projectPlan: normalizeProjectPlan({ ...meeting.projectPlan, status: 'RUNNING' }),
      sceneTurnCount: meeting.projectPlan.sceneTurnCount || 0,
    } : {}),
  };
  meeting = setMeetingStatus(meeting, 'LIVE');
  meeting = withActivity(meeting, interactionMode === 'autonomous' ? 'Full Auto meeting started.' : 'Meeting started.');
  meeting = await saveMeeting(meeting);
  const latest = latestTranscriptText(meeting);
  scheduleSpeaker(meeting, latest, null, 0).catch(() => {});
  return meeting;
}

function autopilotBindingsForArtifact(meeting, run, plan) {
  if (Array.isArray(run?.bindings) && run.bindings.length) return run.bindings;
  return (plan?.roles || []).map((role, index) => {
    const participant = meeting.participants?.[index];
    return {
      roleId: role.id,
      participantId: participant?.id || '',
      provider: participant?.provider || '',
      ...(hasTabId(participant?.tabId) ? { tabId: participant.tabId } : {}),
    };
  });
}

async function packageAutopilotRun(inputMeeting = null) {
  let meeting = inputMeeting || await getMeeting();
  let run = autopilotRunFor(meeting);
  const plan = normalizeProjectPlan(run?.plan || meeting.projectPlan);
  if (!run || !plan) throw new Error('No V2 plan is available for packaging.');
  if (run.state !== 'PACKAGING') run = transitionAutopilot(run, 'PACKAGING', { packagingStartedAt: Date.now() });
  meeting = await saveMeeting(withActivity({ ...meeting, autopilotRun: run }, 'Packaging verified response-card artifacts.', { stage: 'PACKAGING' }));

  try {
    const queue = await loadScreenshotQueue();
    const screenshots = screenshotMembersFromJobs(queue.filter((job) => job.meetingId === meeting.id));
    const completeness = artifactCompleteness({ screenshots, expectedCaptures: Number(run.metrics?.actualTurns) || screenshots.length });
    if (!completeness.complete) throw new Error(`Verified screenshot set is incomplete: ${completeness.missing.join(', ') || 'no response-card PNGs'}.`);
    const bindings = autopilotBindingsForArtifact(meeting, run, plan);
    const provisionalManifest = buildManifest({ plan, run, bindings, screenshots });
    const provisionalReport = buildRunReport({ run, artifactSummary: null });
    const firstBundle = await buildZipBundle({ manifest: provisionalManifest, runReport: provisionalReport, screenshots });
    const artifactPreview = {
      status: 'COMPLETE',
      complete: completeness.complete,
      fileCount: firstBundle.fileCount,
      screenshotCount: screenshots.length,
      requiredMissing: firstBundle.requiredMissing,
      paths: firstBundle.paths,
    };
    run = { ...run, metrics: { ...run.metrics, zipFiles: firstBundle.fileCount } };
    // Build the final bundle from the run that will be complete, but do not
    // persist COMPLETE until the browser confirms the ZIP download finished.
    const completedRun = transitionAutopilot(run, 'COMPLETE', { artifactSummary: artifactPreview, packagingFinishedAt: Date.now() });
    const manifest = buildManifest({ plan, run: completedRun, bindings, screenshots });
    const report = buildRunReport({ run: completedRun, artifactSummary: artifactPreview });
    const bundle = await buildZipBundle({ manifest, runReport: report, screenshots });
    const filename = artifactZipFilename(completedRun.runId);
    if (typeof chrome.downloads?.download !== 'function') throw new Error('Chrome downloads API is unavailable for ZIP packaging.');
    const downloadId = await chrome.downloads.download({
      url: `data:application/zip;base64,${bytesToBase64(bundle.bytes)}`,
      filename,
      saveAs: false,
      conflictAction: 'overwrite',
    });
    await waitForDownloadComplete(downloadId);
    const artifactSummary = {
      ...artifactPreview,
      path: filename,
      downloadId: Number.isInteger(downloadId) ? downloadId : null,
      sizeBytes: bundle.byteLength,
      screenshotCount: screenshots.length,
      checksumCount: bundle.checksums.length,
      checksums: bundle.checksums,
      completeness: 'verified',
      createdAt: Date.now(),
    };
    run = { ...completedRun, artifactSummary };
    meeting = setMeetingStatus({ ...meeting, autopilotRun: run, artifactSummary, projectPlan: normalizeProjectPlan({ ...plan, status: 'COMPLETE' }), activeTransaction: null, nextSpeakerParticipantId: null }, 'FINISHED');
    meeting = withActivity(meeting, `ZIP complete · ${filename} · ${bundle.fileCount} files.`, { stage: 'COMPLETE' });
    return saveMeeting(meeting);
  } catch (error) {
    const message = error?.message || String(error);
    if (run && !['FAILED', 'COMPLETE', 'CANCELLED'].includes(run.state)) {
      run = markAutopilotFailed(run, { error: message, stage: 'PACKAGING' });
    }
    meeting = setMeetingStatus({ ...meeting, autopilotRun: run, artifactSummary: { status: 'INCOMPLETE', error: message } }, 'NEEDS_ATTENTION');
    meeting = withActivity(meeting, `ZIP packaging failed: ${message}`, { level: 'WARN', stage: 'PACKAGING_FAILED' });
    return saveMeeting(meeting);
  }
}

async function finalizeAutopilotResponse(inputMeeting, participant, transaction, responseText) {
  let meeting = inputMeeting || await getMeeting();
  let run = autopilotRunFor(meeting);
  if (!isAutopilotRunActive(run)) return meeting;
  const captureKey = `${meeting.id}:${transaction.transactionId}:${transaction.turnNumber}`;
  if (run.state === 'RUNNING' || run.state === 'WAITING_RESPONSE') run = transitionAutopilot(run, 'CAPTURE_QUEUED', { captureKey, responseStartedAt: Date.now() });
  meeting = await saveMeeting(withActivity({ ...meeting, autopilotRun: run }, `Response verified; capture queued · turn ${transaction.turnNumber}.`, {
    stage: 'CAPTURE_QUEUED',
    participantId: participant.id,
    transactionId: transaction.transactionId,
  }));

  const deadline = Date.now() + 60000;
  let capture = null;
  while (Date.now() < deadline) {
    await processScreenshotQueue().catch(() => {});
    const queue = await loadScreenshotQueue();
    capture = queue.find((job) => job.key === captureKey) || null;
    if (capture?.status === 'complete' || capture?.status === 'failed') break;
    await sleep(500);
  }
  meeting = await getMeeting();
  run = autopilotRunFor(meeting) || run;
  if (run.state === 'PAUSED') {
    const pendingCapture = {
      captureKey,
      participantId: participant.id,
      transactionId: transaction.transactionId,
      turnNumber: transaction.turnNumber,
      responseText: normalizeText(responseText),
    };
    return saveMeeting(withActivity({
      ...meeting,
      autopilotRun: { ...run, pendingCapture },
    }, `Capture ready; waiting for resume · turn ${transaction.turnNumber}.`, {
      stage: 'CAPTURE_PAUSED',
      participantId: participant.id,
      transactionId: transaction.transactionId,
    }));
  }
  if (!capture || capture.status !== 'complete' || capture.verified !== true || !capture.dataBase64) {
    const error = capture?.error || 'Verified response-card PNG was not produced.';
    run = recordCapture(run, { captureKey, status: 'failed', filename: capture?.filename || '', error });
    run = {
      ...run,
      pendingCapture: {
        captureKey,
        participantId: participant.id,
        transactionId: transaction.transactionId,
        turnNumber: transaction.turnNumber,
        responseText: normalizeText(responseText),
      },
    };
    if (run.state !== 'FAILED') run = markAutopilotFailed(run, { error, stage: 'CAPTURE' });
    meeting = setMeetingStatus({ ...meeting, autopilotRun: run }, 'NEEDS_ATTENTION');
    meeting = withActivity(meeting, `Capture failed; autopilot stopped before the next turn: ${error}`, { level: 'WARN', stage: 'CAPTURE_FAILED', participantId: participant.id, transactionId: transaction.transactionId });
    return saveMeeting(meeting);
  }

  run = recordCapture(run, { captureKey, status: 'complete', filename: capture.filename });
  if (run.pendingCapture) run = { ...run, pendingCapture: null };
  const sceneBeforeTurn = currentProjectScene(meeting.projectPlan);
  const sceneTurnNumber = (Number(meeting.projectPlan?.sceneTurnCount) || 0) + 1;
  run = recordProviderTurn(run, {
    providerId: participant.id,
    sceneIndex: (sceneBeforeTurn?.index || 0) + 1,
    turnNumber: sceneTurnNumber,
    captureKey,
  });
  if (run.state === 'CAPTURE_QUEUED') run = transitionAutopilot(run, 'CAPTURE_VERIFIED', { captureKey, captureVerifiedAt: Date.now() });
  if (run.state === 'CAPTURE_VERIFIED') run = transitionAutopilot(run, 'TURN_RECORDED', { turnRecordedAt: Date.now() });

  const progress = recordProjectTurn(meeting.projectPlan, { now: Date.now() });
  run = { ...run, plan: progress.plan, currentSceneIndex: progress.plan?.currentSceneIndex || 0, sceneTurnCount: progress.plan?.sceneTurnCount || 0 };
  meeting = {
    ...meeting,
    autopilotRun: run,
    projectPlan: progress.plan,
    sceneTurnCount: progress.plan?.sceneTurnCount || 0,
    topicText: currentProjectScene(progress.plan)?.opening || meeting.topicText,
  };
  meeting = withActivity(meeting, `Turn ${transaction.turnNumber} captured and recorded · ${participant.label}.`, {
    stage: 'TURN_RECORDED',
    participantId: participant.id,
    transactionId: transaction.transactionId,
  });

  if (progress.transition) {
    const card = buildSceneTransitionCard({ project: progress.plan, fromScene: progress.transition.from, toScene: progress.transition.to, reason: progress.transition.reason });
    meeting = appendTranscript(meeting, { speakerType: 'SYSTEM', text: card.text, turnNumber: meeting.currentTurn, kind: 'SCENE_TRANSITION', sceneTransition: card });
    run = transitionAutopilot(run, 'SCENE_TRANSITION', { fromScene: progress.transition.from.index + 1, toScene: progress.transition.to.index + 1 });
    meeting = withActivity({ ...meeting, autopilotRun: run }, `Scene changed: ${card.to.title}.`, { stage: 'SCENE_TRANSITION' });
    meeting = await saveMeeting(meeting);
    return injectAutopilotRolePackets(meeting);
  }
  if (progress.completed) {
    run = transitionAutopilot(run, 'PACKAGING', { finalTurn: transaction.turnNumber });
    meeting = setMeetingStatus({ ...meeting, autopilotRun: run }, 'READY');
    meeting = await saveMeeting(withActivity(meeting, 'All scenes complete; packaging artifacts.', { stage: 'PACKAGING' }));
    return packageAutopilotRun(meeting);
  }
  run = transitionAutopilot(run, 'RUNNING', { nextTurn: meeting.currentTurn + 1 });
  meeting = { ...meeting, autopilotRun: run };
  meeting = await saveMeeting(meeting);
  if (meeting.status === 'LIVE') await scheduleSpeaker(meeting, responseText, participant.id);
  return meeting;
}

async function completeResponse(message, senderTabId) {
  let meeting = await getMeeting();
  const tx = meeting.activeTransaction;
  if (!tx || !canAcceptEvent(tx, { ...message, tabId: senderTabId })) return meeting;
  if (!normalizeText(message.text) || !message.signature) return meeting;
  const cleanResponseText = sanitizeRelayResponse(message.text, tx.promptText);
  if (!cleanResponseText) return meeting;
  const participant = participantById(meeting, tx.participantId);
  if (!participant) return meeting;
  if (participant.lastKnownAssistantSignature === message.signature && !message.assistantNodeAdvanced) {
    return enterNeedsAttention(meeting, `${participant.label} returned a duplicate response.`, 'VERIFYING_RESPONSE');
  }

  let verify = null;
  try {
    verify = await sendToParticipant(participant, { type: 'GET_TRANSACTION_STATUS', meetingId: meeting.id, transactionId: tx.transactionId, participantId: participant.id });
  } catch { /* event itself remains usable if page changed immediately after sending it */ }
  if (verify?.ok && (!(verify.deliveryConfirmed || verify.matchingUserMessage) || verify.assistantSignature !== message.signature || !verify.changed)) {
    return enterNeedsAttention(meeting, `${participant.label} response could not be correlated to the current turn.`, 'VERIFYING_RESPONSE');
  }

  let nextTx = tx;
  if (nextTx.stage === 'WAITING_FOR_GENERATION') nextTx = transitionTransaction(nextTx, 'RECEIVING');
  if (nextTx.stage === 'RECEIVING' || nextTx.stage === 'DELIVERED' || nextTx.stage === 'WAITING_FOR_GENERATION') nextTx = transitionTransaction(nextTx, 'VERIFYING_RESPONSE');
  nextTx = transitionTransaction(nextTx, 'COMPLETE', { responseText: cleanResponseText, responseSignature: message.signature, error: '' });

  meeting = { ...meeting, activeTransaction: nextTx };
  meeting = updateParticipant(meeting, participant.id, { turnState: 'SPEAKING', lastKnownAssistantSignature: message.signature, lastSeenAt: Date.now() });
  meeting = appendTranscript(meeting, {
    speakerType: 'AI', participantId: participant.id, provider: participant.provider, text: cleanResponseText, turnNumber: tx.turnNumber,
    deliveryStatus: 'CONFIRMED', responseStatus: 'CONFIRMED', transactionId: tx.transactionId,
  });
  meeting = { ...meeting, currentTurn: meeting.currentTurn + 1, activeTransaction: null };
  await queueScreenshotCapture(meeting, participant, nextTx);

  // V2 never schedules the next provider until this response's real card has
  // produced a verified PNG and the turn journal records it.
  if (isAutopilotRunActive(autopilotRunFor(meeting))) return finalizeAutopilotResponse(meeting, participant, nextTx, cleanResponseText);

  if (meeting.projectPlan) {
    const progress = recordProjectTurn(meeting.projectPlan, { now: Date.now() });
    meeting = {
      ...meeting,
      projectPlan: progress.plan,
      sceneTurnCount: progress.plan?.sceneTurnCount || 0,
      topicText: currentProjectScene(progress.plan)?.opening || meeting.topicText,
    };
    meeting = withActivity(meeting, `Turn ${tx.turnNumber} complete · ${participant.label}`, {
      stage: 'COMPLETE',
      participantId: participant.id,
      transactionId: tx.transactionId,
    });
    if (progress.transition) {
      const card = buildSceneTransitionCard({
        project: progress.plan,
        fromScene: progress.transition.from,
        toScene: progress.transition.to,
        reason: progress.transition.reason,
      });
      meeting = appendTranscript(meeting, {
        speakerType: 'SYSTEM',
        text: card.text,
        turnNumber: meeting.currentTurn,
        kind: 'SCENE_TRANSITION',
        sceneTransition: card,
      });
      meeting = withActivity(meeting, `Scene changed: ${card.to.title}.`, { stage: 'SCENE_TRANSITION' });
    }
    if (progress.completed) {
      meeting = setMeetingStatus(meeting, 'FINISHED');
      meeting = withActivity(meeting, 'Project scenes complete.', { stage: 'PROJECT_COMPLETE' });
      const saved = await saveMeeting(meeting);
      processScreenshotQueue().catch(() => {});
      return saved;
    }
    meeting = await saveMeeting(meeting);
    processScreenshotQueue().catch(() => {});
    if (meeting.status === 'LIVE') await scheduleSpeaker(meeting, cleanResponseText, participant.id);
    return meeting;
  }

  const previousSession = meeting.session;
  const nextSession = recordSessionTurn(previousSession);
  meeting = { ...meeting, session: nextSession };
  if (nextSession.status === 'COMPLETE') {
    meeting = withActivity(meeting, `Session complete ??${nextSession.templateId}.`, { stage: 'SESSION_COMPLETE' });
    meeting = setMeetingStatus(meeting, 'FINISHED');
    const saved = await saveMeeting(meeting);
    processScreenshotQueue().catch(() => {});
    return saved;
  }
  if (nextSession.phaseIndex !== previousSession.phaseIndex) {
    meeting = withActivity(meeting, `Session phase advanced ??${currentSessionPhase(nextSession).name}.`, { stage: 'SESSION_PHASE' });
  }

  meeting = withActivity(meeting, `Turn ${tx.turnNumber} complete ← ${participant.label}`, { stage: 'COMPLETE', participantId: participant.id, transactionId: tx.transactionId });

  if (meeting.settings.maxTurns > 0 && meeting.currentTurn >= meeting.settings.maxTurns) {
    meeting = setMeetingStatus(meeting, 'FINISHED');
    meeting = withActivity(meeting, 'Meeting finished at the configured turn limit.');
    const saved = await saveMeeting(meeting);
    processScreenshotQueue().catch(() => {});
    return saved;
  }
  meeting = await saveMeeting(meeting);
  processScreenshotQueue().catch(() => {});
  if (meeting.status === 'LIVE') await scheduleSpeaker(meeting, cleanResponseText, participant.id);
  return meeting;
}

async function watchdogRecover() {
  let meeting = await getMeeting();
  const tx = meeting.activeTransaction;
  if (!tx) {
    const nextAt = Number(meeting.nextSpeakerAt) || 0;
    if (meeting.status === 'LIVE' && nextAt > 0 && nextAt <= Date.now() && meeting.nextSpeakerParticipantId) {
      return executeTurn(meeting.nextSpeakerParticipantId);
    }
    return meeting;
  }
  if (!['LIVE','PAUSED','NEEDS_ATTENTION'].includes(meeting.status)) return meeting;
  const participant = participantById(meeting, tx.participantId);
  if (!participant || !Number.isInteger(participant.tabId)) return enterNeedsAttention(meeting, 'Active participant tab is disconnected.', tx.stage);

  if (['SENDING','VERIFYING_DELIVERY','RETRYING','PREPARING'].includes(tx.stage)) {
    if (meeting.status === 'NEEDS_ATTENTION') return meeting;
    return deliveryWithRetries(meeting.id);
  }

  if (['DELIVERED','WAITING_FOR_GENERATION','RECEIVING','VERIFYING_RESPONSE'].includes(tx.stage)) {
    let status = null;
    try {
      await attachParticipant(meeting, participant.id);
      status = await sendToParticipant(participant, { type: 'GET_TRANSACTION_STATUS', meetingId: meeting.id, transactionId: tx.transactionId, participantId: participant.id });
    } catch {
      try {
        await ensurePreparedOnPage(meeting, participant, tx, { captureBaseline: false });
        await armResponse(meeting, participant, tx);
      } catch (error) {
        if (transactionTimedOut(tx)) return enterNeedsAttention(meeting, `${participant.label} could not reconnect: ${error.message || String(error)}`, tx.stage);
        return meeting;
      }
    }
    const quietMs = Math.max(500, Number(status?.quietMs) || 2000);
    const responseStable = Boolean(status?.changed && Number(status.stableMs) >= quietMs);
    if (status?.ok && (status.deliveryConfirmed || status.matchingUserMessage) && responseStable && status.assistantSignature && status.assistantText && (!status.generating || status.stableMs >= 90000)) {
      return completeResponse({
        meetingId: meeting.id,
        transactionId: tx.transactionId,
        participantId: participant.id,
        text: status.assistantText,
        signature: status.assistantSignature,
        assistantNodeAdvanced: Boolean(status.assistantNodeAdvanced),
        assistantCount: Number(status.assistantCount) || 0,
      }, participant.tabId);
    }
    if (status?.ok && !transactionTimedOut(tx)) {
      // Keep checking the current provider tab while its response settles. This
      // is independent of which browser tab the user is viewing.
      const remainingQuiet = status.changed
        ? Math.max(150, quietMs - Number(status.stableMs || 0) + 100)
        : ACTIVE_TURN_CHECK_DELAY_MS;
      scheduleActiveTurnCheck(Math.min(ACTIVE_TURN_CHECK_DELAY_MS, remainingQuiet));
    }
    if (transactionTimedOut(tx)) {
      const recoveries = Number(tx.recoveryCount) || 0;
      if (recoveries >= 2) return enterNeedsAttention(meeting, `${participant.label} response timed out after recovery attempts.`, tx.stage);
      const patched = { ...tx, recoveryCount: recoveries + 1, lastProgressAt: Date.now(), updatedAt: Date.now() };
      meeting = { ...meeting, activeTransaction: patched };
      meeting = withActivity(meeting, `Response watchdog re-armed ${participant.label} (${patched.recoveryCount}/2)`, { level: 'WARN', stage: tx.stage, participantId: participant.id, transactionId: tx.transactionId });
      meeting = await saveMeeting(meeting);
      await armResponse(meeting, participant, patched).catch(() => {});
    }
  }
  return meeting;
}

const AUTOPILOT_PLAN_POLL_MS = 1200;
const AUTOPILOT_PLAN_TIMEOUT_MS = 90000;

function autopilotNonce() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function plannerParticipant(tabId, provider) {
  return { id: 'plan-generator', tabId: Number(tabId), provider, label: `${providerLabelFor(provider)} Plan Generator` };
}

function autopilotRunFor(meeting) {
  return meeting?.autopilotRun && typeof meeting.autopilotRun === 'object' ? meeting.autopilotRun : null;
}

function assertNoActiveAutopilot(meeting, action = 'manual mutation') {
  return assertManualMutationAllowed(autopilotRunFor(meeting), action);
}

async function persistAutopilotRun(meeting, run, message = '', stage = 'AUTOPILOT') {
  let next = { ...meeting, autopilotRun: run };
  if (message) next = withActivity(next, message, { stage });
  return saveMeeting(next);
}

async function recordAutopilotFailure(runId, error, stage = 'AUTOPILOT') {
  let meeting = await getMeeting();
  const run = autopilotRunFor(meeting);
  if (!run || run.runId !== runId || ['COMPLETE', 'CANCELLED'].includes(run.state)) return meeting;
  const message = error?.message || String(error || 'Autopilot failed.');
  const nextRun = markAutopilotFailed(run, { error: message, stage });
  meeting = setMeetingStatus({ ...meeting, autopilotRun: nextRun }, 'NEEDS_ATTENTION');
  meeting = withActivity(meeting, `V2 autopilot failed: ${nextRun.failureError || message}`, {
    level: 'WARN',
    stage: 'AUTOPILOT_FAILED',
  });
  return saveMeeting(meeting);
}

function autopilotBindingForRole(run, role, index) {
  const bindings = Array.isArray(run?.bindings) ? run.bindings : [];
  return bindings.find((binding) => (
    binding?.roleId === role?.id
    || binding?.role === role?.id
    || Number(binding?.roleIndex) === index
    || Number(binding?.index) === index
  )) || null;
}

function hasTabId(value) {
  return value !== null && value !== undefined && Number.isInteger(Number(value));
}

function roleParticipant(meeting, run, role, index, usedIds = new Set()) {
  const binding = autopilotBindingForRole(run, role, index);
  let participant = binding?.participantId ? participantById(meeting, binding.participantId) : null;
  if (!participant && hasTabId(binding?.tabId)) participant = participantForTab(meeting, Number(binding.tabId));
  if (!participant) participant = meeting.participants.find((item) => !usedIds.has(item.id) && item.slotIndex === index);
  if (!participant) participant = meeting.participants.find((item) => !usedIds.has(item.id));
  return { participant: participant || null, binding };
}

async function bindAutopilotParticipant(meeting, participant, binding) {
  if (!participant || !hasTabId(binding?.tabId) || Number.isInteger(participant.tabId)) return meeting;
  const tabId = Number(binding.tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const provider = classifyUrl(tab?.url || '');
  if (!tab || !provider) throw new Error(`${participant.label || 'Participant'} binding is not a supported AI tab.`);
  return bindParticipant(meeting, participant.id, {
    tabId,
    provider,
    label: participant.label,
    url: tab.url || '',
    connectionState: 'READY',
  });
}

async function ensureAutoRoleTabs(inputMeeting = null, inputPlan = null) {
  let meeting = inputMeeting || await getMeeting();
  let run = autopilotRunFor(meeting);
  const provisioning = run?.autoProvisioning;
  if (!provisioning?.enabled) return meeting;
  const plan = normalizeProjectPlan(inputPlan || run.plan || meeting.projectPlan);
  if (!plan?.roles?.length || !plan?.scenes?.length) throw new Error('A validated project plan is required before opening role tabs.');
  const roles = plan.roles.slice(0, 6);
  if (roles.length < 2) throw new Error('The project plan must contain at least two roles before opening role tabs.');
  meeting = ensureParticipantSlots(meeting, roles.length);

  const manifest = createAutoTabManifest({ roleCount: roles.length, provider: provisioning.provider || AUTO_PROVISION_PROVIDER });
  const roleEntries = manifest.filter((entry) => entry.kind === 'role');
  const configuredTabIds = Array.isArray(provisioning.roleTabIds) ? provisioning.roleTabIds : [];
  const roleTabs = [];
  const newlyOpenedTabIds = [];
  for (const entry of roleEntries) {
    const existing = await runOwnedAiTab(configuredTabIds[entry.roleIndex], provisioning.provider || AUTO_PROVISION_PROVIDER);
    if (existing) {
      roleTabs.push({ ...existing, roleIndex: entry.roleIndex, tabKind: 'role' });
      continue;
    }
    const opened = await openFreshAiTab(provisioning.provider || AUTO_PROVISION_PROVIDER, {
      active: false,
      kind: 'role',
      roleIndex: entry.roleIndex,
      runId: run.runId,
    });
    roleTabs.push(opened);
    newlyOpenedTabIds.push(opened.tabId);
  }

  const mapped = bindAutoRoleSlots({ roles, participants: meeting.participants, tabs: roleTabs });
  let nextMeeting = meeting;
  let bindingChanged = false;
  for (const slot of mapped.roleSlots) {
    const participant = participantById(nextMeeting, slot.participantId);
    if (!participant) throw new Error(`Participant card for ${slot.roleId} is unavailable.`);
    const occupant = participantForTab(nextMeeting, slot.tabId);
    if (occupant && occupant.id !== participant.id) {
      nextMeeting = bindParticipant(nextMeeting, occupant.id, {
        tabId: null,
        provider: null,
        url: '',
        connectionState: 'DISCONNECTED',
      });
      bindingChanged = true;
    }
    const current = participantById(nextMeeting, participant.id);
    if (current.tabId !== slot.tabId || current.provider !== slot.provider || current.label !== slot.label) {
      nextMeeting = bindParticipant(nextMeeting, participant.id, {
        tabId: slot.tabId,
        provider: slot.provider,
        label: slot.label,
        url: roleTabs[slot.roleIndex]?.url || '',
        connectionState: 'RECONNECTING',
      });
      bindingChanged = true;
    }
  }

  const createdTabIds = [...new Set([
    ...(Array.isArray(provisioning.createdTabIds) ? provisioning.createdTabIds : []),
    ...newlyOpenedTabIds,
  ])];
  const nextProvisioning = {
    ...provisioning,
    enabled: true,
    provider: AUTO_PROVISION_PROVIDER,
    plannerTabId: Number(run.plannerTabId) || Number(provisioning.plannerTabId) || null,
    roleCount: roles.length,
    roleTabIds: roleTabs.map((tab) => Number(tab.tabId)),
    roleTabs: roleTabs.map((tab) => ({
      tabId: Number(tab.tabId),
      provider: tab.provider,
      label: tab.label,
      roleIndex: Number(tab.roleIndex),
    })),
    createdTabIds,
    stage: 'ROLE_TABS_READY',
    roleTabsOpenedAt: provisioning.roleTabsOpenedAt || Date.now(),
    lastProvisionedAt: Date.now(),
  };
  run = {
    ...run,
    plan,
    roleSlots: mapped.roleSlots,
    bindings: mapped.bindings,
    autoProvisioning: nextProvisioning,
  };
  nextMeeting = { ...nextMeeting, autopilotRun: run, projectPlan: plan };
  if (newlyOpenedTabIds.length || bindingChanged) {
    nextMeeting = withActivity(nextMeeting, `Opened ${newlyOpenedTabIds.length} fresh ChatGPT role tab(s); ${roles.length} role binding(s) ready.`, {
      stage: 'AUTO_ROLE_TABS_READY',
    });
  }
  return saveMeeting(nextMeeting);
}

async function injectAutopilotRolePackets(inputMeeting = null) {
  let meeting = inputMeeting || await getMeeting();
  let run = autopilotRunFor(meeting);
  let plan = alignPlanToRoleSlots(normalizeProjectPlan(run?.plan || meeting.projectPlan), run?.roleSlots || []);
  if (!run || !plan?.roles?.length || !plan?.scenes?.length) throw new Error('A validated V2 plan is required before role injection.');
  if (run.autoProvisioning?.enabled) {
    meeting = await ensureAutoRoleTabs(meeting, plan);
    run = autopilotRunFor(meeting);
    plan = alignPlanToRoleSlots(normalizeProjectPlan(run?.plan || meeting.projectPlan), run?.roleSlots || []);
  }
  const scene = currentProjectScene(plan);
  const sceneCount = plan.scenes.length;
  const usedParticipantIds = new Set();
  const failures = [];

  // A plan can legitimately introduce more roles than the two starter cards.
  // Add cards and bind unassigned supported tabs deterministically so the
  // binding is visible in the Side Panel before any turn is scheduled.
  while (meeting.participants.length < plan.roles.length && meeting.participants.length < MAX_PARTICIPANTS) meeting = addParticipant(meeting);
  const supported = await listSupportedTabs().catch(() => []);
  const configuredTabIds = new Set((run.roleSlots || []).filter((slot) => Number.isInteger(slot.tabId)).map((slot) => slot.tabId));
  const allowedTabs = (run.roleSlots || []).length ? supported.filter((tab) => configuredTabIds.has(Number(tab.tabId))) : supported;
  const capacity = autopilotTabCapacity({ requiredRoles: plan.roles.length, supportedTabs: allowedTabs });
  if (!capacity.ok) {
    run = transitionAutopilot(run, 'PAUSED', { pausedFrom: run.state, injectionErrors: [{ roleId: '*', packetId: '', error: capacity.message }] });
    meeting = setMeetingStatus({ ...meeting, autopilotRun: run }, 'PAUSED');
    meeting = withActivity(meeting, capacity.message, { level: 'WARN', stage: 'INJECTION_PREFLIGHT' });
    return saveMeeting(meeting);
  }
  const usedTabIds = new Set(meeting.participants.map((item) => item.tabId).filter(Number.isInteger));
  const availableTabs = allowedTabs.filter((tab) => Number.isInteger(tab.tabId) && !usedTabIds.has(tab.tabId));
  for (const [roleIndex, role] of plan.roles.entries()) {
    const participant = meeting.participants[roleIndex];
    const binding = autopilotBindingForRole(run, role, roleIndex);
    if (participant && !Number.isInteger(participant.tabId) && !hasTabId(binding?.tabId) && availableTabs.length) {
      const tab = availableTabs.shift();
      meeting = bindParticipant(meeting, participant.id, { tabId: tab.tabId, provider: tab.provider, label: providerLabelFor(tab.provider), url: tab.url || '', connectionState: 'READY' });
      run = { ...run, bindings: [...(run.bindings || []), { participantId: participant.id, roleId: role.id, roleIndex, tabId: tab.tabId, provider: tab.provider }] };
    }
  }

  run = transitionAutopilot(run, 'INJECTING', { plan, currentSceneIndex: scene.index, sceneTurnCount: 0, injectionStartedAt: Date.now(), injectionErrors: [] });
  meeting = await persistAutopilotRun(meeting, run, `Injecting ${plan.roles.length} role packet(s) for scene ${scene.index + 1}/${sceneCount}.`, 'INJECTING');

  for (const [roleIndex, role] of plan.roles.entries()) {
    const resolved = roleParticipant(meeting, run, role, roleIndex, usedParticipantIds);
    let participant = resolved.participant;
    const binding = resolved.binding;
    const packetId = `${run.runId}:scene-${scene.index + 1}:role-${role.id}`;
    if (!participant) {
      const error = `No participant tab is bound for role ${role.name || role.id}.`;
      failures.push({ roleId: role.id, packetId, error });
      run = recordProviderInjection(run, { providerId: role.id, roleId: role.id, sceneIndex: scene.index + 1, packetId, status: 'failed', error });
      continue;
    }
    usedParticipantIds.add(participant.id);
    try {
      meeting = await bindAutopilotParticipant(meeting, participant, binding);
      participant = participantById(meeting, participant.id);
      meeting = await attachParticipant(meeting, participant.id);
      participant = participantById(meeting, participant.id);
      const packet = buildRolePacket({
        plan,
        projectBrief: run.projectBrief,
        role,
        scene: { ...scene, index: scene.index + 1, sceneNumber: scene.index + 1 },
        sceneTurn: 1,
        sceneCount,
        packetId,
      });
      const sent = await sendToParticipant(participant, {
        type: 'SEND_TLA_ROLE_PACKET',
        meetingId: meeting.id,
        participantId: participant.id,
        packetId: packet.packetId,
        text: packet.text,
        contentHash: packet.contentHash,
        sceneIndex: scene.index + 1,
      });
      if (!sent?.ok || (!sent.sent && !sent.alreadyPresent)) throw new Error(sent?.error || 'Role packet send failed.');
      let verified = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        verified = await sendToParticipant(participant, {
          type: 'VERIFY_TLA_MESSAGE',
          meetingId: meeting.id,
          participantId: participant.id,
          packetId: packet.packetId,
          contentHash: packet.contentHash,
          baselineUserCount: sent.baselineUserCount,
        }).catch((error) => ({ ok: false, error: error.message || String(error) }));
        if (verified?.verified) break;
        await sleep(180);
      }
      if (!verified?.verified) throw new Error(verified?.error || 'Role packet composer message could not be verified.');
      run = recordProviderInjection(run, {
        providerId: participant.id,
        roleId: role.id,
        sceneIndex: scene.index + 1,
        packetId: packet.packetId,
        status: 'verified',
      });
      meeting = updateParticipant(meeting, participant.id, {
        role: role.role || role.label || role.name,
        rolePrompt: role.roleGuidance || role.rolePrompt || '',
        connectionState: 'READY',
        lastSeenAt: Date.now(),
      });
      meeting = withActivity({ ...meeting, autopilotRun: run }, `Role packet verified → ${participant.label} · ${role.name || role.id}`, {
        stage: 'INJECTION_VERIFIED',
        participantId: participant.id,
      });
    } catch (error) {
      const message = error?.message || String(error);
      failures.push({ roleId: role.id, participantId: participant.id, packetId, error: message });
      run = recordProviderInjection(run, {
        providerId: participant.id,
        roleId: role.id,
        sceneIndex: scene.index + 1,
        packetId,
        status: 'failed',
        error: message,
      });
      meeting = withActivity({ ...meeting, autopilotRun: run }, `Role packet failed → ${participant.label}: ${message}`, {
        level: 'WARN',
        stage: 'INJECTING',
        participantId: participant.id,
      });
    }
    meeting = { ...meeting, autopilotRun: run };
    await saveMeeting(meeting);
  }

  if (failures.length) {
    run = transitionAutopilot(run, 'PAUSED', { pausedFrom: 'INJECTING', injectionErrors: failures });
    meeting = setMeetingStatus({ ...meeting, autopilotRun: run }, 'PAUSED');
    meeting = withActivity(meeting, `${failures.length} role packet(s) need attention. Reconnect the listed AI tab(s) and resume.`, { level: 'WARN', stage: 'INJECTION_FAILED' });
    return saveMeeting(meeting);
  }

  run = transitionAutopilot(run, 'INJECTION_VERIFIED', { injectionVerifiedAt: Date.now(), injectionErrors: [] });
  meeting = { ...meeting, autopilotRun: run, projectPlan: normalizeProjectPlan({ ...plan, status: 'RUNNING', approval: { approved: true, approvedAt: Date.now(), scope: 'all' } }), interactionMode: 'autonomous', topicText: scene.opening || plan.premise, session: startSession(meeting.session), sceneTurnCount: 0 };
  meeting = withActivity(meeting, 'All role packets verified. Starting autonomous turns.', { stage: 'INJECTION_VERIFIED' });
  await saveMeeting(meeting);
  run = transitionAutopilot(run, 'RUNNING', { startedAt: Date.now() });
  meeting = setMeetingStatus({ ...meeting, autopilotRun: run }, 'LIVE');
  meeting = withActivity(meeting, 'V2 autopilot is running.', { stage: 'RUNNING' });
  meeting = await saveMeeting(meeting);
  scheduleSpeaker(meeting, latestTranscriptText(meeting), null, 0).catch(() => {});
  return meeting;
}

async function waitForPlanResponse(participant, request, afterTimestamp) {
  const deadline = Date.now() + AUTOPILOT_PLAN_TIMEOUT_MS;
  let previousSignature = '';
  let stablePolls = 0;
  while (Date.now() < deadline) {
    const result = await sendToParticipant(participant, {
      type: 'READ_TLA_PLAN_RESPONSE',
      requestId: request.requestId,
      requestNonce: request.requestNonce,
      afterTimestamp,
    }).catch((error) => ({ ok: false, error: error.message || String(error) }));
    if (result?.ready && result.responseText) {
      const gate = planResponseGate({
        responseText: result.responseText,
        responseSignature: result.assistantSignature,
        previousSignature,
        stablePolls,
        generating: result.generating,
      });
      previousSignature = gate.signature;
      stablePolls = gate.stablePolls;
      if (gate.ready) return result;
    }
    await sleep(AUTOPILOT_PLAN_POLL_MS);
  }
  return { ok: false, timedOut: true, error: 'Plan generator response timed out.' };
}

async function resolveAutopilotPlan(runId, plannerTabId, provider, projectBrief, roleHints = '', roleSlots = []) {
  let meeting = await getMeeting();
  let run = autopilotRunFor(meeting);
  if (!run || run.runId !== runId || ['PAUSED', 'CANCELLED', 'FAILED', 'COMPLETE'].includes(run.state)) return meeting;
  const requestId = run.plan?.requestId || runId;
  const requestNonce = run.plan?.requestNonce || autopilotNonce();
  const participant = plannerParticipant(plannerTabId, provider);
  const autoRoleProvisioning = Boolean(run.autoProvisioning?.enabled);
  let prompt = buildPlanPrompt({ projectBrief, roleHints, roleSlots, requestId, requestNonce, language: run.plan?.language || 'ko', autoRoleProvisioning });
  let response = null;
  let candidate = null;
  let errors = [];
  let sentAt = Date.now();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    meeting = await getMeeting();
    run = autopilotRunFor(meeting);
    if (!run || run.runId !== runId || ['PAUSED', 'CANCELLED', 'FAILED', 'COMPLETE'].includes(run.state)) return meeting;
    run = recordPlanAttempt(run, { attempt, outcome: attempt === 1 ? 'requested' : 'repairing', errors });
    meeting = await persistAutopilotRun(meeting, run, attempt === 1 ? 'Plan request sent to the web AI.' : `Plan repair request ${attempt - 1} sent.`, 'PLAN_REQUEST');
    const sent = await sendToParticipant(participant, { type: 'SEND_TLA_PLAN_PROMPT', prompt, requestId, requestNonce }).catch((error) => ({ ok: false, error: error.message || String(error) }));
    if (!sent?.ok) {
      errors = [{ code: 'PLAN_SEND_FAILED', path: '$', message: sent?.error || 'Plan request could not be sent.' }];
      break;
    }
    sentAt = Number(sent.sentAt) || Date.now();
    response = await waitForPlanResponse(participant, { requestId, requestNonce }, sentAt);
    meeting = await getMeeting();
    run = autopilotRunFor(meeting);
    if (!run || run.runId !== runId || ['PAUSED', 'CANCELLED', 'FAILED', 'COMPLETE'].includes(run.state)) return meeting;
    if (!response?.responseText) {
      errors = [{ code: response?.timedOut ? 'PLAN_TIMEOUT' : 'PLAN_RESPONSE_MISSING', path: '$', message: response?.error || 'Plan response was not found.' }];
      break;
    }
    const envelope = extractPlanEnvelope(response.responseText, { requestId, requestNonce });
    candidate = envelope.candidate;
    errors = envelope.errors || [];
    if (envelope.ok && candidate) {
      try {
        const adaptedPlan = adaptAiProjectPlan({ aiPlan: candidate, keyword: projectBrief, requestId, requestNonce, now: Date.now() });
        const plan = alignPlanToRoleSlots(adaptedPlan, autoRoleProvisioning ? [] : roleSlots);
        meeting = await getMeeting();
        run = autopilotRunFor(meeting);
        if (!run || run.runId !== runId || ['PAUSED', 'CANCELLED', 'FAILED', 'COMPLETE'].includes(run.state)) return meeting;
        run = transitionAutopilot(run, 'PLAN_RECEIVED', { plan, plannerResponseAt: Date.now() });
        run = transitionAutopilot(run, 'PLAN_VALIDATED', { plan, metrics: { ...run.metrics, expectedTurns: plan.totalExpectedTurns, maxTurns: plan.totalMaxTurns } });
        meeting = { ...meeting, projectPlan: plan, topicText: currentProjectScene(plan)?.opening || plan.premise };
        const saved = await persistAutopilotRun(meeting, run, `Web-AI plan validated: ${plan.title}.`, 'PLAN_VALIDATED');
        let prepared;
        try {
          prepared = await ensureAutoRoleTabs(saved, plan);
        } catch (error) {
          await recordAutopilotFailure(runId, error, 'ROLE_TAB_PROVISION');
          return getMeeting();
        }
        return injectAutopilotRolePackets(prepared);
      } catch (error) {
        errors = Array.isArray(error.errors) ? error.errors : [{ code: 'PLAN_NORMALIZE_FAILED', path: '$', message: error.message || String(error) }];
      }
    }
    if (attempt < 3) {
      meeting = await getMeeting();
      run = autopilotRunFor(meeting);
      if (!run || run.runId !== runId || ['PAUSED', 'CANCELLED', 'FAILED', 'COMPLETE'].includes(run.state)) return meeting;
      run = transitionAutopilot(run, 'PLAN_REPAIRING', { lastPlanErrors: errors });
      meeting = await persistAutopilotRun(meeting, run, `Plan validation failed; requesting repair ${attempt}/2.`, 'PLAN_REPAIR');
      prompt = buildPlanRepairPrompt({ candidateJson: candidate ? JSON.stringify(candidate) : '', errors, roleSlots, requestId, requestNonce, autoRoleProvisioning });
    }
  }

  meeting = await getMeeting();
  run = autopilotRunFor(meeting);
  if (!run || run.runId !== runId || ['PAUSED', 'CANCELLED', 'FAILED', 'COMPLETE'].includes(run.state)) return meeting;
  const baseFallback = buildLocalSkeletonProjectPlan(projectBrief, { requestId, requestNonce, now: Date.now() });
  const fallback = alignPlanToRoleSlots(baseFallback, autoRoleProvisioning ? [] : (run.roleSlots || []));
  run = transitionAutopilot(run, 'PLAN_FALLBACK_USED', { plan: fallback, lastPlanErrors: errors, fallbackReason: errors[0]?.message || 'Web AI plan was unavailable.' });
  run = { ...run, metrics: { ...run.metrics, expectedTurns: fallback.totalExpectedTurns, maxTurns: fallback.totalMaxTurns } };
  meeting = { ...meeting, projectPlan: fallback, topicText: currentProjectScene(fallback)?.opening || fallback.premise };
  const saved = await persistAutopilotRun(meeting, run, `Using complete local fallback plan: ${fallback.title}.`, 'PLAN_FALLBACK');
  let prepared;
  try {
    prepared = await ensureAutoRoleTabs(saved, fallback);
  } catch (error) {
    await recordAutopilotFailure(runId, error, 'ROLE_TAB_PROVISION');
    return getMeeting();
  }
  return injectAutopilotRolePackets(prepared);
}

async function recoverAutopilotPlan() {
  const meeting = await getMeeting();
  const run = autopilotRunFor(meeting);
  if (!run || !['PLAN_REQUESTED', 'PLAN_REPAIRING'].includes(run.state)) return meeting;
  if (autopilotPlanInFlightRunId === run.runId) return meeting;
  autopilotPlanInFlightRunId = run.runId;
  try {
    const tab = await chrome.tabs.get(Number(run.plannerTabId)).catch(() => null);
    const provider = classifyUrl(tab?.url || '');
    if (!provider) throw new Error('The plan-generator AI tab is closed or no longer supported. Reopen it and resume V2.');
    return await resolveAutopilotPlan(run.runId, Number(run.plannerTabId), provider, run.projectBrief, run.roleHints || '', run.roleSlots || []);
  } finally {
    if (autopilotPlanInFlightRunId === run.runId) autopilotPlanInFlightRunId = null;
  }
}

async function ensureAutopilotWorkRecovery() {
  const meeting = await getMeeting();
  const run = autopilotRunFor(meeting);
  if (run && ['PLAN_REQUESTED', 'PLAN_REPAIRING'].includes(run.state)) {
    await scheduleAutopilotPlanAlarm().catch(() => {});
  }
  if (meeting.status === 'LIVE' && !meeting.activeTransaction && meeting.nextSpeakerParticipantId && Number(meeting.nextSpeakerAt) > 0) {
    await scheduleSpeakerAlarm(meeting.nextSpeakerAt).catch(() => {});
  }
  return meeting;
}

async function startAutopilot(message = {}) {
  let meeting = await getMeeting();
  assertNoActiveAutopilot(meeting, 'starting another autopilot run');
  if (meeting.status === 'LIVE' || meeting.activeTransaction) throw new Error('Pause the current meeting before starting a V2 autopilot run.');
  const existingRun = autopilotRunFor(meeting);
  if ((meeting.projectPlan || existingRun) && message.replaceConfirmed !== true) {
    throw new Error('Confirm replacing the current project before starting a new V2 run.');
  }
  const projectBrief = normalizeText(message.projectBrief || message.keyword || '');
  if (!projectBrief) throw new Error('A project brief is required.');
  const autoProvision = normalizeAutoProvisionRequest(message);
  let plannerTabId = Number(message.plannerTabId);
  let provider = '';
  let plannerTab = null;
  if (autoProvision.enabled) {
    plannerTab = await openFreshAiTab(autoProvision.provider, { active: false, kind: 'planner' });
    plannerTabId = plannerTab.tabId;
    provider = plannerTab.provider;
  } else {
    if (!Number.isInteger(plannerTabId)) throw new Error('Choose one web AI tab as the plan generator.');
    const tab = await chrome.tabs.get(plannerTabId).catch(() => null);
    if (!tab) throw new Error('The selected plan-generator tab is no longer open.');
    provider = classifyUrl(tab.url || '');
    if (!provider) throw new Error('The selected plan-generator tab is not a supported AI site.');
  }
  const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const requestId = runId;
  const requestNonce = autopilotNonce();
  const baseSkeleton = buildLocalSkeletonProjectPlan(projectBrief, { requestId, requestNonce, now: Date.now(), language: message.language || 'ko' });
  meeting = ensureParticipantSlots(meeting, Math.max(2, meeting.participants?.length || 0, baseSkeleton.roles.length));
  let roleSlots = [];
  let skeleton = baseSkeleton;
  let bindings = [];
  let roleHints = normalizeText(message.roleHints || '');
  if (!autoProvision.enabled) {
    roleSlots = configuredRoleSlots(meeting, baseSkeleton);
    skeleton = alignPlanToRoleSlots(baseSkeleton, roleSlots);
    const supported = await listSupportedTabs().catch(() => []);
    const supportedIds = new Set(supported.map((item) => Number(item.tabId)));
    const configuredTabs = roleSlots.filter((slot) => Number.isInteger(slot.tabId) && supportedIds.has(slot.tabId)).map((slot) => ({ tabId: slot.tabId, provider: slot.provider, label: slot.label }));
    const capacity = autopilotTabCapacity({ requiredRoles: skeleton.roles.length, supportedTabs: configuredTabs });
    if (!capacity.ok) throw new Error(capacity.message);
    const suppliedBindings = Array.isArray(message.bindings) ? message.bindings : [];
    const bindingsByParticipant = new Map(suppliedBindings.filter((binding) => binding?.participantId).map((binding) => [binding.participantId, binding]));
    bindings = roleSlots.map((slot, index) => ({
      ...(bindingsByParticipant.get(slot.participantId) || suppliedBindings[index] || {}),
      participantId: slot.participantId,
      roleId: slot.roleId,
      roleIndex: index,
      tabId: slot.tabId,
      provider: slot.provider,
    }));
    roleHints = roleHintsForSlots(roleSlots) || roleHints;
  }
  await clearScreenshotJobsForMeeting(meeting.id);
  let run = createAutopilotRun({ runId, projectBrief, plannerTabId, skeletonPlan: skeleton, bindings, roleHints, roleSlots, now: Date.now() });
  if (autoProvision.enabled) {
    run = {
      ...run,
      autoProvisioning: {
        enabled: true,
        provider: AUTO_PROVISION_PROVIDER,
        reuseExisting: false,
        plannerTabId,
        plannerTab: plannerTab ? {
          tabId: plannerTab.tabId,
          provider: plannerTab.provider,
          label: plannerTab.label,
        } : null,
        roleCount: null,
        roleTabIds: [],
        roleTabs: [],
        createdTabIds: plannerTab ? [plannerTab.tabId] : [],
        stage: 'PLANNER_OPENED',
        startedAt: Date.now(),
      },
    };
  }
  run = transitionAutopilot(run, 'PLAN_REQUESTED', { requestId, requestNonce, plannerProvider: provider });
  meeting = {
    ...meeting,
    status: 'READY',
    projectPlan: skeleton,
    autopilotRun: run,
    artifactSummary: null,
    topicText: currentProjectScene(skeleton)?.opening || skeleton.premise,
    currentTurn: 0,
    sceneTurnCount: 0,
    activeTransaction: null,
    nextSpeakerParticipantId: null,
    nextSpeakerAt: null,
    transcript: [],
    settings: { ...meeting.settings, maxTurns: skeleton.totalMaxTurns, minDelayMs: skeleton.defaults.minDelayMs, captureScreenshots: true, retryLimit: skeleton.defaults.retryLimit },
  };
  meeting = withActivity(meeting, `V2 autopilot started with ${skeleton.scenes.length} local scenes.`, { stage: 'AUTOPILOT_START' });
  const saved = await saveMeeting(meeting);
  enqueue(() => recoverAutopilotPlan())
    .catch((error) => recordAutopilotFailure(runId, error, 'PLAN_REQUEST').catch(() => {}));
  try {
    await scheduleAutopilotPlanAlarm();
  } catch (error) {
    return recordAutopilotFailure(runId, error, 'PLAN_SCHEDULE');
  }
  return saved;
}

async function pauseAutopilot() {
  let meeting = await getMeeting();
  const run = autopilotRunFor(meeting);
  if (!run || ['COMPLETE', 'FAILED', 'CANCELLED'].includes(run.state)) throw new Error('There is no active V2 autopilot run to pause.');
  const nextRun = transitionAutopilot(run, 'PAUSED', { pausedFrom: run.state });
  await clearAutopilotWorkAlarms();
  await backgroundTabController.releaseAll().catch(() => {});
  meeting = setMeetingStatus({ ...meeting, autopilotRun: nextRun, nextSpeakerAt: null }, 'PAUSED');
  return saveMeeting(withActivity(meeting, 'V2 autopilot paused.', { stage: 'AUTOPILOT_PAUSE' }));
}

async function resumeAutopilot() {
  let meeting = await getMeeting();
  let run = autopilotRunFor(meeting);
  const persistedState = String(run?.state || '').toUpperCase();
  if (meeting.status === 'PAUSED' && run && AUTOPILOT_STATES.includes(persistedState)
    && !['PAUSED', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(persistedState)) {
    run = transitionAutopilot(run, 'PAUSED', {
      pausedFrom: run.pausedFrom || persistedState,
      recoveredAt: Date.now(),
    });
    meeting = await saveMeeting(withActivity({ ...meeting, autopilotRun: run }, 'Reconciled a paused autopilot run before resume.', { stage: 'AUTOPILOT_RESUME_RECONCILE' }));
  }
  if (!run || !['PAUSED', 'CANCELLED'].includes(run.state)) throw new Error('There is no paused or stopped V2 autopilot run.');
  const wasStopped = run.state === 'CANCELLED';
  const savedResumeState = wasStopped ? run.stoppedFrom : run.pausedFrom;
  let resumeState = AUTOPILOT_STATES.includes(savedResumeState)
    && !['PAUSED', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(savedResumeState)
    ? savedResumeState
    : 'PLAN_REQUESTED';
  // Emergency stop is terminal for normal state transitions, but an explicit
  // user resume can safely re-enter through PAUSED while preserving the run.
  const resumableRun = wasStopped ? { ...run, state: 'PAUSED', pausedFrom: resumeState } : run;
  let nextRun = transitionAutopilot(resumableRun, resumeState, { pausedFrom: null, stoppedByUser: false, resumedAt: Date.now() });
  const liveResumeStates = new Set(['RUNNING', 'WAITING_RESPONSE', 'CAPTURE_QUEUED', 'CAPTURE_VERIFIED', 'TURN_RECORDED']);
  meeting = setMeetingStatus({ ...meeting, autopilotRun: nextRun }, liveResumeStates.has(resumeState) ? 'LIVE' : 'READY');
  let saved = await saveMeeting(withActivity(meeting, 'V2 autopilot resumed.', { stage: 'AUTOPILOT_RESUME' }));
  const schedule = (task, stage = 'AUTOPILOT_RESUME') => setTimeout(() => enqueue(task)
    .catch((error) => recordAutopilotFailure(nextRun.runId, error, stage).catch(() => {})), 0);

  if (resumeState === 'READY') {
    const plan = normalizeProjectPlan(nextRun.plan || saved.projectPlan);
    if (plan?.roles?.length && plan?.scenes?.length && plan.status !== 'DRAFT') {
      resumeState = plan.source === 'local-fallback' ? 'PLAN_FALLBACK_USED' : 'PLAN_VALIDATED';
      nextRun = transitionAutopilot(nextRun, resumeState, { plan });
      saved = await saveMeeting(withActivity({ ...saved, autopilotRun: nextRun, projectPlan: plan }, 'Resuming from the saved project plan.', { stage: resumeState }));
    } else {
      nextRun = transitionAutopilot(nextRun, 'PLAN_REQUESTED', {
        requestId: nextRun.plan?.requestId || nextRun.runId,
        requestNonce: nextRun.plan?.requestNonce || autopilotNonce(),
      });
      resumeState = 'PLAN_REQUESTED';
      saved = await saveMeeting(withActivity({ ...saved, autopilotRun: nextRun }, 'Resuming plan generation.', { stage: 'PLAN_REQUEST' }));
    }
  }

  if (resumeState === 'PLAN_REQUESTED' || resumeState === 'PLAN_REPAIRING') {
    enqueue(() => recoverAutopilotPlan())
      .catch((error) => recordAutopilotFailure(nextRun.runId, error, 'PLAN_REQUEST').catch(() => {}));
    await scheduleAutopilotPlanAlarm();
  } else if (resumeState === 'PLAN_RECEIVED') {
    const plan = normalizeProjectPlan(nextRun.plan || saved.projectPlan);
    if (!plan?.roles?.length || !plan?.scenes?.length) throw new Error('Saved plan is incomplete; reset and start a new V2 run.');
    nextRun = transitionAutopilot(nextRun, 'PLAN_VALIDATED', { plan });
    saved = await saveMeeting(withActivity({ ...saved, autopilotRun: nextRun, projectPlan: plan }, 'Saved plan validated after resume.', { stage: 'PLAN_VALIDATED' }));
    schedule(() => injectAutopilotRolePackets(saved));
  } else if (resumeState === 'PLAN_VALIDATED' || resumeState === 'PLAN_FALLBACK_USED') {
    schedule(() => injectAutopilotRolePackets(saved));
  } else if (resumeState === 'INJECTING' || resumeState === 'SCENE_TRANSITION') {
    schedule(() => injectAutopilotRolePackets(saved));
  } else if (resumeState === 'RUNNING') {
    if (saved.activeTransaction) schedule(() => watchdogRecover());
    else schedule(() => scheduleSpeaker(saved, latestTranscriptText(saved), null, 0));
  } else if (resumeState === 'WAITING_RESPONSE') {
    schedule(() => watchdogRecover());
  } else if (resumeState === 'CAPTURE_QUEUED' || resumeState === 'CAPTURE_VERIFIED') {
    const pending = nextRun.pendingCapture || {};
    const captureKey = pending.captureKey || nextRun.captureKey || Object.keys(nextRun.seen?.captures || {}).find((key) => nextRun.seen.captures[key]?.status !== 'complete');
    const queue = await loadScreenshotQueue();
    const capture = queue.find((job) => job.key === captureKey) || null;
    const transactionId = pending.transactionId || capture?.transactionId || saved.transcript.slice().reverse().find((entry) => entry?.speakerType === 'AI' && entry?.transactionId)?.transactionId;
    const transcriptEntry = saved.transcript.slice().reverse().find((entry) => entry?.transactionId === transactionId && entry?.speakerType === 'AI');
    const participantId = pending.participantId || capture?.participantId || transcriptEntry?.participantId;
    const participant = participantById(saved, participantId);
    const turnNumber = Number(pending.turnNumber || capture?.turnNumber || transcriptEntry?.turnNumber || saved.currentTurn || 0);
    const responseText = normalizeText(pending.responseText || transcriptEntry?.text || '');
    if (!captureKey || !transactionId || !participant || !turnNumber || !responseText) {
      const failed = transitionAutopilot(nextRun, 'FAILED', { resumeError: 'Saved capture continuation is incomplete.' });
      saved = await saveMeeting(withActivity(setMeetingStatus({ ...saved, autopilotRun: failed }, 'NEEDS_ATTENTION'), 'Cannot resume capture: saved response context is incomplete.', { level: 'WARN', stage: 'RESUME_FAILED' }));
    } else {
      const live = await saveMeeting(setMeetingStatus({ ...saved, autopilotRun: nextRun }, 'LIVE'));
      schedule(() => finalizeAutopilotResponse(live, participant, { transactionId, turnNumber, participantId: participant.id }, responseText));
    }
  } else if (resumeState === 'TURN_RECORDED') {
    const plan = normalizeProjectPlan(saved.projectPlan || nextRun.plan);
    if (plan?.status === 'COMPLETE') {
      nextRun = transitionAutopilot(nextRun, 'PACKAGING', { finalTurn: saved.currentTurn });
      saved = await saveMeeting(withActivity(setMeetingStatus({ ...saved, autopilotRun: nextRun }, 'READY'), 'Resuming final artifact packaging.', { stage: 'PACKAGING' }));
      schedule(() => packageAutopilotRun(saved));
    } else {
      nextRun = transitionAutopilot(nextRun, 'RUNNING', { nextTurn: saved.currentTurn + 1 });
      saved = await saveMeeting(setMeetingStatus({ ...saved, autopilotRun: nextRun }, 'LIVE'));
      if (saved.activeTransaction) schedule(() => watchdogRecover());
      else schedule(() => scheduleSpeaker(saved, latestTranscriptText(saved), null, 0));
    }
  } else if (resumeState === 'PACKAGING') {
    saved = await saveMeeting(setMeetingStatus({ ...saved, autopilotRun: nextRun }, 'READY'));
    schedule(() => packageAutopilotRun(saved));
  } else if (resumeState === 'INJECTION_VERIFIED') {
    const started = transitionAutopilot(nextRun, 'RUNNING', { startedAt: Date.now() });
    const live = await saveMeeting(setMeetingStatus({ ...saved, autopilotRun: started }, 'LIVE'));
    schedule(() => scheduleSpeaker(live, latestTranscriptText(live), null, 0));
  }
  return getMeeting();
}

async function stopAutopilot() {
  let meeting = await getMeeting();
  const run = autopilotRunFor(meeting);
  if (!run || ['COMPLETE', 'CANCELLED'].includes(run.state)) throw new Error('There is no stoppable V2 autopilot run.');
  const nextRun = transitionAutopilot(run, 'CANCELLED', { stoppedByUser: true, stoppedFrom: run.state });
  await clearAutopilotWorkAlarms();
  await backgroundTabController.releaseAll().catch(() => {});
  meeting = setMeetingStatus({ ...meeting, autopilotRun: nextRun, activeTransaction: null, nextSpeakerParticipantId: null, nextSpeakerAt: null }, 'FINISHED');
  return saveMeeting(withActivity(meeting, 'V2 autopilot stopped by user.', { stage: 'AUTOPILOT_STOP' }));
}

async function retryAutopilot() {
  let meeting = await getMeeting();
  let run = autopilotRunFor(meeting);
  if (!run || run.state !== 'FAILED') throw new Error('There is no failed V2 autopilot step to retry.');

  const failureStage = String(run.failureStage || '').toUpperCase();
  if (failureStage === 'CAPTURE' || run.pendingCapture?.captureKey) {
    const pending = run.pendingCapture || {};
    if (!pending.captureKey || !pending.transactionId || !pending.participantId) {
      throw new Error('The failed capture has no saved continuation context. Reset and start a new run.');
    }
    const queue = await loadScreenshotQueue();
    const existing = queue.find((job) => job?.key === pending.captureKey);
    if (!existing) throw new Error('The failed screenshot job is no longer available. Reset and start a new run.');
    const retryQueue = markScreenshotJob(queue, pending.captureKey, {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      error: '',
      verified: false,
      dataBase64: '',
      downloadId: null,
      capturedAt: null,
    });
    await saveScreenshotQueue(retryQueue);
    await chrome.alarms.clear(SCREENSHOT_RETRY_ALARM).catch(() => false);
    run = transitionAutopilot(run, 'PAUSED', {
      pausedFrom: 'CAPTURE_QUEUED',
      retryRequestedAt: Date.now(),
      failureError: '',
      failureStage: '',
    });
    meeting = await saveMeeting(withActivity(setMeetingStatus({ ...meeting, autopilotRun: run, artifactSummary: null }, 'PAUSED'), 'Retrying the failed screenshot step.', { stage: 'CAPTURE_RETRY' }));
    return resumeAutopilot();
  }

  if (failureStage === 'PACKAGING' || run.packagingError) {
    run = transitionAutopilot(run, 'PACKAGING', { retryRequestedAt: Date.now(), packagingError: '' });
    meeting = await saveMeeting(withActivity(setMeetingStatus({ ...meeting, autopilotRun: run }, 'READY'), 'Retrying ZIP packaging.', { stage: 'PACKAGING_RETRY' }));
    return packageAutopilotRun(meeting);
  }

  const resumeState = AUTOPILOT_STATES.includes(run.failedFrom)
    && !['PAUSED', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(run.failedFrom)
    ? run.failedFrom
    : 'PLAN_REQUESTED';
  run = transitionAutopilot(run, 'PAUSED', { pausedFrom: resumeState, retryRequestedAt: Date.now(), failureError: '', failureStage: '' });
  await saveMeeting(withActivity(setMeetingStatus({ ...meeting, autopilotRun: run }, 'PAUSED'), 'Retrying the failed V2 step.', { stage: 'AUTOPILOT_RETRY' }));
  return resumeAutopilot();
}

async function resetAutopilot() {
  const meeting = await getMeeting();
  const run = autopilotRunFor(meeting);
  if (!run || !['PAUSED', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(run.state)) {
    throw new Error('Pause or stop the V2 autopilot before resetting it.');
  }
  await clearAutopilotWorkAlarms();
  await backgroundTabController.releaseAll().catch(() => {});
  await clearScreenshotJobsForMeeting(meeting.id);
  const reset = resetAutopilotMeeting(meeting);
  return saveMeeting(withActivity(reset, 'V2 autopilot reset; ready for a new project.', { stage: 'AUTOPILOT_RESET' }));
}

async function handleCommand(message, sender) {
  switch (message.type) {
    case 'GET_MEETING_STATE': return { ok: true, meeting: publicMeetingState(await getMeeting()) };
    case 'GET_AUTOPILOT_STATE': return { ok: true, meeting: publicMeetingState(await getMeeting()) };
    case 'START_AUTOPILOT': return { ok: true, meeting: await startAutopilot(message) };
    case 'PAUSE_AUTOPILOT': return { ok: true, meeting: await pauseAutopilot() };
    case 'RESUME_AUTOPILOT': return { ok: true, meeting: await resumeAutopilot() };
    case 'STOP_AUTOPILOT': return { ok: true, meeting: await stopAutopilot() };
    case 'RETRY_AUTOPILOT': return { ok: true, meeting: await retryAutopilot() };
    case 'RESET_AUTOPILOT': return { ok: true, meeting: await resetAutopilot() };
    case 'LIST_SUPPORTED_TABS': return { ok: true, tabs: await listSupportedTabs() };
    case 'OPEN_AI_TABS': return openAiTabs(message);
    case 'LIST_SCREENSHOT_JOBS': {
      const meeting = await getMeeting();
      const queue = (await loadScreenshotQueue())
        .filter((job) => job.meetingId === meeting.id)
        .sort((a, b) => Number(a.turnNumber) - Number(b.turnNumber) || String(a.createdAt).localeCompare(String(b.createdAt)));
      return { ok: true, jobs: queue };
    }
    case 'OPEN_SCREENSHOT': {
      const downloadId = Number(message.downloadId);
      if (!Number.isInteger(downloadId)) throw new Error('Screenshot file is not available yet.');
      if (typeof chrome.downloads?.open !== 'function') throw new Error('Chrome cannot open this screenshot.');
      await chrome.downloads.open(downloadId);
      return { ok: true };
    }
    case 'OPEN_ARTIFACT': {
      const downloadId = Number(message.downloadId);
      if (!Number.isInteger(downloadId)) throw new Error('ZIP file is not available yet.');
      if (typeof chrome.downloads?.open !== 'function') throw new Error('Chrome cannot open this ZIP.');
      await chrome.downloads.open(downloadId);
      return { ok: true };
    }
    case 'CHECK_ACTIVE_TURN': return { ok: true, meeting: publicMeetingState(await watchdogRecover()) };
    case 'NEW_MEETING': return { ok: true, meeting: await newMeeting(message.options || {}) };
    case 'BUILD_PROJECT_PLAN': return { ok: true, meeting: await buildProjectRun(message.keyword || '') };
    case 'APPROVE_PROJECT_RUN': return { ok: true, meeting: await approveProjectRun(message.scope || 'all') };
    case 'ADD_PARTICIPANT': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'adding a participant');
      m = addParticipant(m);
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'REMOVE_PARTICIPANT': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'removing a participant');
      if (m.activeTransaction?.participantId === message.participantId) throw new Error('Skip or end the active turn before removing this participant.');
      const removed = participantById(m, message.participantId);
      await backgroundTabController.release(removed).catch(() => {});
      m = removeParticipant(m, message.participantId);
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'BIND_PARTICIPANT': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'binding a participant');
      const tab = await chrome.tabs.get(Number(message.tabId)).catch(() => null);
      if (!tab) throw new Error('Selected tab is no longer open.');
      const provider = classifyUrl(tab.url || '');
      if (!provider) throw new Error('Selected tab is not a supported AI site.');
      m = bindParticipant(m, message.participantId, { tabId: tab.id, provider, label: providerLabelFor(provider), url: tab.url || '', connectionState: 'READY' });
      m = await attachParticipant(m, message.participantId).catch(() => updateParticipant(m, message.participantId, { connectionState: 'ERROR' }));
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'START_MEETING': return { ok: true, meeting: await startMeeting(message.seedText || '', message.mode || null) };
    case 'SET_INTERACTION_MODE': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'changing interaction mode');
      if (!canChangeInteractionMode(m)) throw new Error('Pause the meeting and finish the active turn before changing modes.');
      const mode = normalizeInteractionMode(message.mode);
      const topicText = mode === 'autonomous'
        ? (normalizeTopicText(m.topicText) || normalizeText([...m.transcript].reverse().find((entry) => entry.speakerType === 'USER' && normalizeText(entry.text))?.text || ''))
        : m.topicText;
      m = {
        ...m,
        interactionMode: mode,
        topicText,
        ...(m.status === 'READY' ? { activeTransaction: null, nextSpeakerParticipantId: null } : {}),
      };
      m = withActivity(m, mode === 'autonomous' ? 'Full Auto mode selected.' : 'Interactive mode selected.');
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'PAUSE_MEETING': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'pausing the manual meeting');
      m = setMeetingStatus(m, 'PAUSED');
      await backgroundTabController.releaseAll().catch(() => {});
      m = withActivity(m, 'Meeting paused by user.');
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'RESUME_MEETING': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'resuming the manual meeting');
      const resumedSession = m.session?.status === 'IDLE'
        ? startSession(m.session)
        : { ...normalizeSession(m.session), status: 'RUNNING' };
      m = {
        ...m,
        session: resumedSession,
        loopGuard: createLoopGuardState(m.loopGuard),
      };
      m = setMeetingStatus(m, 'LIVE');
      m = withActivity(m, 'Meeting resumed.');
      m = await saveMeeting(m);
      if (m.activeTransaction) setTimeout(() => enqueue(() => watchdogRecover()), 0);
      else await scheduleSpeaker(m, latestTranscriptText(m), null, 0);
      return { ok: true, meeting: await getMeeting() };
    }
    case 'END_MEETING': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'ending the manual meeting');
      await backgroundTabController.releaseAll().catch(() => {});
      m = setMeetingStatus({ ...m, activeTransaction: null, nextSpeakerParticipantId: null }, 'FINISHED');
      m = withActivity(m, 'Meeting ended by user.');
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'USER_MESSAGE': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'adding a manual message');
      const text = normalizeText(message.text || '');
      if (!text) throw new Error('Message is empty.');
      if (!canAcceptUserMessage(m)) throw new Error('Full Auto is observing only. Pause and join the conversation to send a user message.');
      if (isRelayEnvelope(text)) throw new Error('Time Less Auto internal meeting envelopes cannot be added as human messages.');
      if (m.interactionMode === 'autonomous') {
        m = { ...m, topicText: text };
        m = withActivity(m, 'Full Auto topic updated.');
      } else {
        m = appendTranscript(m, { speakerType: 'USER', text, turnNumber: m.currentTurn });
        m = withActivity(m, 'User added a message to the room.');
      }
      m = await saveMeeting(m);
      if (m.status === 'LIVE' && !m.activeTransaction) await scheduleSpeaker(m, text, null, 0);
      return { ok: true, meeting: m };
    }
    case 'UPDATE_MEETING_TITLE': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'editing the meeting title');
      m = { ...m, title: normalizeText(message.title || '') || 'New AI Meeting' };
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'UPDATE_MEETING_SETTINGS': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'changing meeting settings');
      const patch = message.settings || {};
      const guardNumber = (key, fallback) => {
        if (!Object.hasOwn(patch, key)) return fallback;
        const value = Number(patch[key]);
        return Number.isFinite(value) ? Math.min(100000, Math.max(0, Math.floor(value))) : fallback;
      };
      m = { ...m, settings: {
        ...m.settings,
        ...(Object.hasOwn(patch,'maxTurns') ? { maxTurns: Math.max(0, Number(patch.maxTurns) || 0) } : {}),
        ...(Object.hasOwn(patch,'minDelayMs') ? { minDelayMs: Math.max(0, Number(patch.minDelayMs) || 0) } : {}),
        ...(Object.hasOwn(patch,'smartRouting') ? { smartRouting: Boolean(patch.smartRouting) } : {}),
        ...(Object.hasOwn(patch,'captureScreenshots') ? { captureScreenshots: Boolean(patch.captureScreenshots) } : {}),
        ...(Object.hasOwn(patch,'retryLimit') ? { retryLimit: Math.min(5, Math.max(0, Number(patch.retryLimit) || 0)) } : {}),
        ...(Object.hasOwn(patch,'responseTimeoutMs') ? { responseTimeoutMs: Math.max(30000, Number(patch.responseTimeoutMs) || 120000) } : {}),
        ...(Object.hasOwn(patch,'loopGuardEnabled') ? { loopGuardEnabled: Boolean(patch.loopGuardEnabled) } : {}),
        ...(Object.hasOwn(patch,'loopGuardInteractive') ? { loopGuardInteractive: Boolean(patch.loopGuardInteractive) } : {}),
        ...(Object.hasOwn(patch,'loopGuardMaxHops') ? { loopGuardMaxHops: guardNumber('loopGuardMaxHops', m.settings.loopGuardMaxHops) } : {}),
        ...(Object.hasOwn(patch,'loopGuardMaxSameSpeaker') ? { loopGuardMaxSameSpeaker: guardNumber('loopGuardMaxSameSpeaker', m.settings.loopGuardMaxSameSpeaker) } : {}),
        ...(Object.hasOwn(patch,'loopGuardMaxSameRoute') ? { loopGuardMaxSameRoute: guardNumber('loopGuardMaxSameRoute', m.settings.loopGuardMaxSameRoute) } : {}),
      } };
      m = { ...m, loopGuard: {
        ...m.loopGuard,
        enabled: m.settings.loopGuardEnabled !== false,
        maxHops: m.settings.loopGuardMaxHops,
        maxSameSpeaker: m.settings.loopGuardMaxSameSpeaker,
        maxSameRoute: m.settings.loopGuardMaxSameRoute,
      } };
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'UPDATE_PARTICIPANT_COORDINATION': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'changing participant roles');
      if (!canChangeInteractionMode(m)) throw new Error('Pause the meeting and finish the active turn before changing participant roles.');
      const participant = participantById(m, message.participantId);
      if (!participant) throw new Error('Participant not found.');
      const coordination = normalizeParticipantCoordination({ role: message.role, rolePrompt: message.rolePrompt });
      const hasConfiguredRole = Boolean(coordination.role || coordination.rolePrompt);
      m = updateParticipant(m, participant.id, {
        role: coordination.role,
        rolePrompt: coordination.rolePrompt,
        roleConfiguredAt: hasConfiguredRole ? (Number(participant.roleConfiguredAt) || Date.now()) : null,
      });
      if (m.status === 'READY') m = invalidateProjectApproval(m);
      m = withActivity(m, `${participant.label} role updated.`);
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'UPDATE_SESSION_TEMPLATE': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'changing the session');
      if (!canChangeInteractionMode(m)) throw new Error('Pause the meeting and finish the active turn before changing the session.');
      m = { ...m, session: normalizeSession({ templateId: message.templateId, status: 'IDLE' }) };
      m = withActivity(m, `Session template selected ??${m.session.templateId}.`);
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'UPDATE_LOOP_GUARD': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'changing Loop Guard');
      if (!canChangeInteractionMode(m)) throw new Error('Pause the meeting and finish the active turn before changing Loop Guard.');
      const patch = message.settings || {};
      const guardNumber = (key, fallback) => {
        const value = Number(patch[key]);
        return Number.isFinite(value) ? Math.min(100000, Math.max(0, Math.floor(value))) : fallback;
      };
      const settings = {
        ...m.settings,
        ...(Object.hasOwn(patch, 'loopGuardEnabled') ? { loopGuardEnabled: Boolean(patch.loopGuardEnabled) } : {}),
        ...(Object.hasOwn(patch, 'loopGuardInteractive') ? { loopGuardInteractive: Boolean(patch.loopGuardInteractive) } : {}),
        ...(Object.hasOwn(patch, 'loopGuardMaxHops') ? { loopGuardMaxHops: guardNumber('loopGuardMaxHops', m.settings.loopGuardMaxHops) } : {}),
        ...(Object.hasOwn(patch, 'loopGuardMaxSameSpeaker') ? { loopGuardMaxSameSpeaker: guardNumber('loopGuardMaxSameSpeaker', m.settings.loopGuardMaxSameSpeaker) } : {}),
        ...(Object.hasOwn(patch, 'loopGuardMaxSameRoute') ? { loopGuardMaxSameRoute: guardNumber('loopGuardMaxSameRoute', m.settings.loopGuardMaxSameRoute) } : {}),
      };
      m = { ...m, settings, loopGuard: {
        ...m.loopGuard,
        enabled: settings.loopGuardEnabled !== false,
        maxHops: settings.loopGuardMaxHops,
        maxSameSpeaker: settings.loopGuardMaxSameSpeaker,
        maxSameRoute: settings.loopGuardMaxSameRoute,
      } };
      m = withActivity(m, 'Loop Guard settings updated.');
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'RETRY_TRANSACTION': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'retrying a manual transaction');
      const tx = m.activeTransaction;
      if (!tx) throw new Error('There is no transaction to retry.');
      const participantId = tx.participantId;
      // Automatic recovery is at-most-once. A fresh send is allowed only when
      // the human explicitly presses Retry, and it gets a fresh transaction id
      // so stale provider events cannot complete the new attempt.
      m = setMeetingStatus({ ...m, activeTransaction: null }, 'LIVE');
      m = withActivity(m, 'Manual retry requested; starting a fresh transaction.', { stage: 'RETRYING', participantId, transactionId: tx.transactionId });
      m = await saveMeeting(m);
      setTimeout(() => enqueue(() => executeTurn(participantId)), 0);
      return { ok: true, meeting: m };
    }
    case 'SKIP_PARTICIPANT': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'skipping a manual participant');
      const tx = m.activeTransaction;
      if (!tx) throw new Error('There is no active participant to skip.');
      const currentId = tx.participantId;
      m = withActivity(m, `Skipped ${participantById(m, currentId)?.label || 'participant'}.`, { level: 'WARN', stage: 'SKIPPED', participantId: currentId, transactionId: tx.transactionId });
      m = updateParticipant(m, currentId, { turnState: 'LISTENING' });
      m = setMeetingStatus({ ...m, activeTransaction: null }, 'LIVE');
      m = await saveMeeting(m);
      await scheduleSpeaker(m, latestTranscriptText(m), currentId, 0);
      return { ok: true, meeting: await getMeeting() };
    }
    case 'RECONNECT_PARTICIPANT': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'reconnecting a manual participant');
      const id = message.participantId || m.activeTransaction?.participantId;
      if (!id) throw new Error('No participant selected for reconnect.');
      m = await attachParticipant(m, id);
      m = withActivity(m, `${participantById(m,id)?.label || 'Participant'} reconnected.`);
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'CLEAR_TRANSCRIPT': {
      let m = await getMeeting();
      assertNoActiveAutopilot(m, 'clearing the transcript');
      if (m.status === 'LIVE' && m.activeTransaction) throw new Error('Pause or end the active turn before clearing the transcript.');
      m = {
        ...m,
        transcript: [],
        currentTurn: 0,
        activeTransaction: null,
        nextSpeakerParticipantId: null,
        session: normalizeSession({ templateId: m.session?.templateId, status: 'IDLE' }),
        loopGuard: createLoopGuardState(m.loopGuard),
      };
      m = withActivity(m, 'Transcript cleared.');
      return { ok: true, meeting: await saveMeeting(m) };
    }
    case 'RESPONSE_CANDIDATE': {
      let m = await getMeeting();
      const tx = m.activeTransaction;
      if (tx && canAcceptEvent(tx, { ...message, tabId: sender.tab?.id })) {
        if (tx.stage === 'WAITING_FOR_GENERATION') {
          const nextTx = transitionTransaction(tx, 'RECEIVING');
          m = { ...m, activeTransaction: nextTx };
          m = updateParticipant(m, tx.participantId, { turnState: 'RECEIVING' });
          m = withActivity(m, 'Response candidate detected.', { stage: 'RECEIVING', participantId: tx.participantId, transactionId: tx.transactionId });
          m = await saveMeeting(m);
        }
        scheduleActiveTurnCheck();
      }
      return { ok: true, meeting: m };
    }
    case 'RESPONSE_CONFIRMED': return { ok: true, meeting: await completeResponse(message, sender.tab?.id) };
    case 'PAGE_READY': {
      let m = await getMeeting();
      const tabId = sender.tab?.id;
      const p = participantForTab(m, tabId);
      if (p) {
        const provider = classifyUrl(sender.tab?.url || message.url || '');
        if (provider) {
          m = updateParticipant(m, p.id, { provider, url: sender.tab?.url || message.url || '', connectionState: 'READY', lastSeenAt: Date.now() });
          m = await saveMeeting(m);
          await sendToParticipant(participantById(m,p.id), { type: 'ATTACH_PARTICIPANT', meetingId: m.id, participantId: p.id }).catch(() => {});
          if (m.activeTransaction?.participantId === p.id) setTimeout(() => enqueue(() => watchdogRecover()), 250);
        }
      }
      return { ok: true };
    }
    default: return { ok: false, error: 'Unknown message' };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelAction();
  ensureWatchdog();
  ensureAutopilotWorkRecovery().catch(() => {});
  getMeeting().catch(() => {});
  processScreenshotQueue().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  enableSidePanelAction();
  ensureWatchdog();
  ensureAutopilotWorkRecovery().catch(() => {});
  getMeeting().catch(() => {});
  processScreenshotQueue().catch(() => {});
});
ensureWatchdog().catch(() => {});
ensureAutopilotWorkRecovery().catch(() => {});
processScreenshotQueue().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const readOnly = new Set(['GET_MEETING_STATE','LIST_SUPPORTED_TABS']);
  const runner = readOnly.has(message?.type) ? () => handleCommand(message, sender) : () => enqueue(() => handleCommand(message, sender));
  runner().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === AUTOPILOT_PLAN_ALARM) {
    enqueue(() => recoverAutopilotPlan())
      .catch(async (error) => {
        const meeting = await getMeeting().catch(() => null);
        const run = autopilotRunFor(meeting);
        if (run) await recordAutopilotFailure(run.runId, error, 'PLAN_REQUEST').catch(() => {});
      });
    return;
  }
  if (alarm?.name === SPEAKER_ALARM) {
    enqueue(async () => {
      const meeting = await getMeeting();
      if (meeting.status !== 'LIVE' || meeting.activeTransaction) return meeting;
      const nextAt = Number(meeting.nextSpeakerAt) || 0;
      if (nextAt > Date.now() + 150) {
        await scheduleSpeakerAlarm(nextAt).catch(() => {});
        return meeting;
      }
      if (meeting.nextSpeakerParticipantId) return executeTurn(meeting.nextSpeakerParticipantId);
      return meeting;
    }).catch(() => {});
    return;
  }
  if (alarm?.name === WATCHDOG_ALARM) {
    enqueue(() => watchdogRecover()).catch(() => {});
    processScreenshotQueue().catch(() => {});
    return;
  }
  if (alarm?.name === SCREENSHOT_RETRY_ALARM) {
    processScreenshotQueue().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    await backgroundTabController.release(tabId).catch(() => {});
    let m = await getMeeting();
    const p = participantForTab(m, tabId);
    if (!p) return;
    m = updateParticipant(m, p.id, { tabId: null, url: '', connectionState: 'DISCONNECTED', turnState: 'WAITING' });
    m = withActivity(m, `${p.label} tab closed.`, { level: 'WARN', participantId: p.id });
    if (m.activeTransaction?.participantId === p.id) return enterNeedsAttention(m, `${p.label} tab closed during an active turn.`, m.activeTransaction.stage);
    await saveMeeting(m);
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  enqueue(async () => {
    let m = await getMeeting();
    const p = participantForTab(m, tabId);
    if (!p) return;
    const provider = classifyUrl(tab.url || '');
    if (!provider) {
      m = updateParticipant(m, p.id, { connectionState: 'RECONNECTING', url: tab.url || '' });
      await saveMeeting(m);
      return;
    }
    m = updateParticipant(m, p.id, { provider, connectionState: 'READY', url: tab.url || '', lastSeenAt: Date.now() });
    m = await saveMeeting(m);
    await attachParticipant(m, p.id).catch(() => {});
    if (m.activeTransaction?.participantId === p.id) setTimeout(() => enqueue(() => watchdogRecover()), 250);
  }).catch(() => {});
});
