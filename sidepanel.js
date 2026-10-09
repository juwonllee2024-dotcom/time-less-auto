import { buildYouTubeSurfaceModel } from './youtube-ui-model.mjs';
import { selectAutopilotParticipants } from './project-engine.mjs';

const $ = (id) => document.getElementById(id);

let meeting = null;
let supportedTabs = [];
let screenshotJobs = [];
let titleSaveTimer = null;
let capturePollTimer = null;
let captureRefreshInFlight = false;

const SESSION_OPTIONS = [
  ['freeform', '자유 장면'],
  ['channel-9-axis', '9축 분석'],
  ['debate', '토론'],
  ['planning', '기획'],
];

const els = {
  appShell: $('appShell'), progressRail: $('progressRail'), focusCard: $('focusCard'), focusTitle: $('focusTitle'), focusMessage: $('focusMessage'), focusAction: $('focusAction'),
  projectKeyword: $('projectKeyword'), buildProject: $('buildProject'), projectPlan: $('projectPlan'), projectSummary: $('projectSummary'),
  sceneList: $('sceneList'), projectApproval: $('projectApproval'), approveProjectRun: $('approveProjectRun'), sceneProgress: $('sceneProgress'),
  plannerTab: $('plannerTab'), startAutopilot: $('startAutopilot'), pauseAutopilot: $('pauseAutopilot'), retryAutopilot: $('retryAutopilot'), stopAutopilot: $('stopAutopilot'), resetAutopilot: $('resetAutopilot'),
  openAiTabs: $('openAiTabs'), aiProviderChoices: $('aiProviderChoices'),
  autopilotPhase: $('autopilotPhase'), autopilotSummary: $('autopilotSummary'), autopilotTimeline: $('autopilotTimeline'), autopilotProviders: $('autopilotProviders'), artifactCard: $('artifactCard'),
  meetingTitle: $('meetingTitle'), meetingStatus: $('meetingStatus'), participantCount: $('participantCount'), participants: $('participants'), liveHeading: $('liveHeading'),
  addParticipant: $('addParticipant'), refreshTabs: $('refreshTabs'), transcript: $('transcript'), turnCounter: $('turnCounter'), composer: $('composer'),
  interactionMode: $('interactionMode'), interactiveMode: $('interactiveMode'), autonomousMode: $('autonomousMode'), joinConversation: $('joinConversation'), modeHint: $('modeHint'),
  sendUserMessage: $('sendUserMessage'), startMeeting: $('startMeeting'), pauseMeeting: $('pauseMeeting'), endMeeting: $('endMeeting'), uiNotice: $('uiNotice'),
  attentionStrip: $('attentionStrip'), attentionMessage: $('attentionMessage'), retryTransaction: $('retryTransaction'), skipParticipant: $('skipParticipant'), reconnectParticipant: $('reconnectParticipant'),
  captureSummary: $('captureSummary'), captureList: $('captureList'),
  maxTurns: $('maxTurns'), delaySeconds: $('delaySeconds'), retryLimit: $('retryLimit'), responseTimeout: $('responseTimeout'), smartRouting: $('smartRouting'), captureScreenshots: $('captureScreenshots'),
  sessionTemplate: $('sessionTemplate'), sessionPhaseHint: $('sessionPhaseHint'), loopGuardEnabled: $('loopGuardEnabled'), loopGuardInteractive: $('loopGuardInteractive'),
  loopGuardMaxHops: $('loopGuardMaxHops'), loopGuardMaxSameSpeaker: $('loopGuardMaxSameSpeaker'), loopGuardMaxSameRoute: $('loopGuardMaxSameRoute'),
  clearTranscript: $('clearTranscript'), newMeeting: $('newMeeting'), activityCount: $('activityCount'), activityLog: $('activityLog'),
};

async function call(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw new Error(result?.error || 'Time Less Auto 명령을 완료하지 못했어요.');
  if (result.meeting) meeting = result.meeting;
  return result;
}

function notice(text = '', error = false) {
  els.uiNotice.textContent = text;
  els.uiNotice.classList.toggle('error', Boolean(error));
}

function timeLabel(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function providerLabel(provider) {
  return { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', copilot: 'Copilot' }[provider] || 'AI';
}

function activeParticipantId() {
  return meeting?.activeTransaction?.participantId || meeting?.nextSpeakerParticipantId || null;
}

function autopilotIsActive() {
  const state = String(meeting?.autopilotRun?.state || '').toUpperCase();
  return Boolean(state) && !['COMPLETE', 'FAILED', 'CANCELLED'].includes(state);
}

function selectedAutopilotParticipants() {
  return selectAutopilotParticipants(meeting, { roles: [{}, {}] });
}

function isEditable() {
  return meeting && ['READY', 'PAUSED'].includes(meeting.status) && !meeting.activeTransaction && !autopilotIsActive();
}

function focusPhaseFor(model) {
  const autopilotPhase = String(model?.autopilot?.phase || '').toUpperCase();
  if (autopilotPhase === 'COMPLETE' || autopilotPhase === 'PACKAGING' || model?.status?.key === 'FINISHED') return 'output';
  if (['LIVE', 'PAUSED', 'NEEDS_ATTENTION'].includes(model?.status?.key) || [
    'INJECTING', 'INJECTION_VERIFIED', 'RUNNING', 'WAITING_RESPONSE', 'CAPTURE_QUEUED', 'CAPTURE_VERIFIED', 'TURN_RECORDED', 'SCENE_TRANSITION', 'FAILED',
  ].includes(autopilotPhase)) return 'run';
  return 'design';
}

function focusCopyFor(model, phase) {
  const project = model?.project;
  const runPhase = String(model?.autopilot?.phase || '').toUpperCase();
  if (phase === 'output') {
    if (runPhase === 'PACKAGING') return { title: '결과 파일을 만드는 중이에요', message: '검증된 PNG와 기록을 ZIP으로 묶고 있어요.', action: '결과 보기', target: 'scrollOutput' };
    const count = model?.autopilot?.metrics?.successfulCaptures || model?.captures?.counts?.complete || 0;
    return { title: '결과가 준비됐어요', message: `실제 응답 캡처 ${count}개를 확인하고 ZIP을 열 수 있어요.`, action: '결과 보기', target: 'scrollOutput' };
  }
  if (runPhase === 'FAILED') return { title: '실패한 단계가 있어요', message: '저장된 지점에서 실패 단계만 다시 시도할 수 있어요.', action: '실패 단계 재시도', target: 'retryAutopilot' };
  if (model?.status?.key === 'NEEDS_ATTENTION') return { title: '잠시 확인이 필요해요', message: '응답 또는 AI 연결 상태를 확인하고 다음 행동을 선택하세요.', action: '복구 보기', target: 'scrollRun' };
  if (runPhase === 'PAUSED' || model?.status?.key === 'PAUSED') return { title: '진행이 일시정지됐어요', message: '저장된 장면과 턴에서 이어갈 수 있어요.', action: '계속하기', target: autopilotIsActive() || ['PAUSED', 'CANCELLED'].includes(runPhase) ? 'pauseAutopilot' : 'pauseMeeting' };
  if (['PLAN_REQUESTED', 'PLAN_RECEIVED', 'PLAN_REPAIRING', 'PLAN_VALIDATED', 'PLAN_FALLBACK_USED'].includes(runPhase)) {
    const autoStage = model?.autopilot?.autoProvisioning?.stage;
    const message = autoStage === 'ROLE_TABS_READY'
      ? '설계에 맞는 새 ChatGPT 역할 탭을 준비했어요. 역할 지침을 넣고 곧 대화를 시작합니다.'
      : '새 ChatGPT 설계 탭에 키워드를 보내고, 응답을 검증하고 있어요.';
    return { title: autoStage === 'ROLE_TABS_READY' ? '역할 탭을 준비 중이에요' : '설계 AI가 프로젝트를 만드는 중이에요', message, action: '진행 화면 보기', target: 'scrollRun' };
  }
  if (phase === 'run') {
    const current = project?.currentScene;
    return { title: current ? `장면 ${current.number}. ${current.title}` : '장면을 진행 중이에요', message: 'AI 응답 카드가 확인되면 다음 턴으로 넘어갑니다.', action: '진행 화면 보기', target: 'scrollRun' };
  }
  if (project && !project.approval.approved) return { title: '설계를 확인하세요', message: `${project.sceneCount}개 장면의 역할과 턴을 확인한 뒤 실행을 승인하세요.`, action: '실행 승인', target: 'approveProjectRun' };
  if (project) return { title: '키워드 하나로 다시 시작하세요', message: '자동 모드가 설계 ChatGPT 탭과 역할 탭을 모두 준비합니다.', action: '자동 설계 시작', target: 'startAutopilot' };
  return { title: '키워드 하나만 입력하세요', message: 'ChatGPT 설계 탭, 역할 탭, 대화, 실제 캡처 ZIP까지 자동으로 만듭니다.', action: '자동 설계 시작', target: 'startAutopilot' };
}

function renderFocusState(model) {
  if (!els.appShell || !els.focusCard) return;
  const phase = focusPhaseFor(model);
  const copy = focusCopyFor(model, phase);
  els.appShell.dataset.uiPhase = phase;
  els.appShell.setAttribute('data-ui-phase', phase);
  els.focusCard.dataset.phase = phase;
  els.focusTitle.textContent = copy.title;
  els.focusMessage.textContent = copy.message;
  els.focusAction.textContent = copy.action;
  els.focusAction.dataset.target = copy.target;
  const target = els[copy.target] || null;
  els.focusAction.disabled = Boolean(target?.disabled);
  for (const step of els.progressRail?.querySelectorAll('[data-step]') || []) {
    const stepIndex = ['design', 'run', 'output'].indexOf(step.dataset.step);
    const phaseIndex = ['design', 'run', 'output'].indexOf(phase);
    const state = stepIndex === phaseIndex ? 'active' : stepIndex < phaseIndex ? 'complete' : 'upcoming';
    step.dataset.state = state;
    if (state === 'active') step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
  for (const [step, element] of [['design', $('designWorkspace')], ['run', $('conversationWorkspace')], ['output', $('outputWorkspace')]]) {
    if (element) element.dataset.current = String(step === phase);
  }
  if (els.liveHeading) els.liveHeading.textContent = model?.project?.currentScene?.title || (model?.status?.key === 'READY' ? '대화 준비 중' : '장면 대화');
}

async function saveParticipantCoordination(participantId, role, rolePrompt) {
  try {
    await call('UPDATE_PARTICIPANT_COORDINATION', { participantId, role, rolePrompt });
    render();
  } catch (error) {
    notice(error.message, true);
  }
}

function renderParticipants(model) {
  const activeId = activeParticipantId();
  const editable = isEditable();
  const usedTabIds = new Set(model.characters.map((character) => meeting.participants.find((p) => p.id === character.id)?.tabId).filter(Number.isInteger));
  els.participants.replaceChildren();

  for (const [index, character] of model.characters.entries()) {
    const source = meeting.participants.find((participant) => participant.id === character.id) || {};
    const card = document.createElement('article');
    card.className = 'participant-card';
    card.dataset.active = String(character.id === activeId);
    card.dataset.state = source.turnState || 'WAITING';
    card.dataset.error = String(['ERROR', 'DISCONNECTED', 'RECONNECTING'].includes(source.connectionState));

    const top = document.createElement('div');
    top.className = 'participant-top';
    const identity = document.createElement('div');
    identity.className = 'participant-name';
    const dot = document.createElement('span');
    dot.className = 'provider-dot';
    const name = document.createElement('span');
    name.textContent = character.name || `캐릭터 ${index + 1}`;
    identity.append(dot, name);
    const state = document.createElement('span');
    state.className = 'participant-state';
    state.textContent = source.connectionState !== 'READY'
      ? ({ ERROR: '연결 확인', DISCONNECTED: '연결 끊김', RECONNECTING: '다시 연결 중' }[source.connectionState] || '대기')
      : ({ SPEAKING: '응답 중', RECEIVING: '응답 받는 중', LISTENING: '듣는 중' }[source.turnState] || '연결됨');
    top.append(identity, state);

    if (meeting.participants.length > 2 && character.id !== activeId) {
      const remove = document.createElement('button');
      remove.className = 'remove-participant';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '캐릭터 삭제';
      remove.addEventListener('click', async () => {
        try {
          await call('REMOVE_PARTICIPANT', { participantId: character.id });
          render();
        } catch (error) {
          notice(error.message, true);
        }
      });
      top.append(remove);
    }

    const select = document.createElement('select');
    select.className = 'participant-select';
    select.setAttribute('aria-label', `캐릭터 ${index + 1} AI 탭`);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = character.connected ? `${character.providerLabel} 탭` : 'AI 탭 선택';
    select.append(placeholder);
    for (const tab of supportedTabs) {
      if (usedTabIds.has(tab.tabId) && tab.tabId !== source.tabId) continue;
      const option = document.createElement('option');
      option.value = String(tab.tabId);
      option.textContent = tab.label;
      option.selected = tab.tabId === source.tabId;
      select.append(option);
    }
    select.disabled = !editable;
    select.addEventListener('change', async () => {
      if (!select.value) return;
      select.disabled = true;
      try {
        await call('BIND_PARTICIPANT', { participantId: character.id, tabId: Number(select.value) });
        await refreshTabs(false);
        render();
        notice('AI 탭을 연결했어요.');
      } catch (error) {
        notice(error.message, true);
        select.disabled = false;
      }
    });

    const role = document.createElement('input');
    role.className = 'participant-role';
    role.type = 'text';
    role.maxLength = 200;
    role.value = character.role;
    role.placeholder = '역할 (예: 싸가지 없는 유학생)';
    role.setAttribute('aria-label', `${character.name} 역할`);
    role.disabled = !editable;

    const rolePrompt = document.createElement('input');
    rolePrompt.className = 'participant-role-prompt';
    rolePrompt.type = 'text';
    rolePrompt.maxLength = 200;
    rolePrompt.value = character.rolePrompt;
    rolePrompt.placeholder = '말투·규칙 (선택)';
    rolePrompt.setAttribute('aria-label', `${character.name} 역할 가이드`);
    rolePrompt.disabled = !editable;
    role.addEventListener('change', () => saveParticipantCoordination(character.id, role.value, rolePrompt.value));
    rolePrompt.addEventListener('change', () => saveParticipantCoordination(character.id, role.value, rolePrompt.value));

    card.append(top, select, role, rolePrompt);
    els.participants.append(card);
  }

  els.participantCount.textContent = `${model.characters.length}명`;
  els.addParticipant.disabled = !model.actions.canAddCharacter || !editable;
}

function renderTranscript(model) {
  els.transcript.replaceChildren();
  if (!model.transcript.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '✦';
    const strong = document.createElement('strong');
    strong.textContent = '아직 시작하지 않았어요.';
    const hint = document.createElement('span');
    hint.textContent = '아이디어와 캐릭터를 정한 뒤 장면을 시작하세요.';
    empty.append(icon, strong, hint);
    els.transcript.append(empty);
    return;
  }

  for (const entry of model.transcript) {
    const transition = entry.kind === 'SCENE_TRANSITION' || entry.sceneTransition?.kind === 'SCENE_TRANSITION';
    if (transition) {
      const card = document.createElement('article');
      card.className = 'scene-transition-card';
      card.dataset.kind = 'SCENE_TRANSITION';
      const title = document.createElement('strong');
      title.textContent = '장면 전환';
      const body = document.createElement('p');
      body.textContent = entry.sceneTransition?.text || entry.text || '';
      card.append(title, body);
      els.transcript.append(card);
      continue;
    }
    const participant = meeting.participants.find((item) => item.id === entry.participantId);
    const item = document.createElement('article');
    item.className = `message ${entry.speakerType === 'USER' ? 'user' : 'ai'}`;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const speaker = document.createElement('span');
    speaker.className = 'message-speaker';
    speaker.textContent = entry.speakerType === 'USER' ? '나' : (participant?.label || providerLabel(entry.provider));
    const turn = document.createElement('span');
    turn.textContent = entry.turnNumber ? `장면 ${entry.turnNumber}` : '메모';
    const time = document.createElement('span');
    time.textContent = timeLabel(entry.createdAt);
    meta.append(speaker, turn, time);
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    const captureOnly = Boolean(meeting?.autopilotRun) && entry.speakerType === 'AI';
    const capture = captureOnly
      ? screenshotJobs.find((job) => job.transactionId === entry.transactionId)
      : null;
    if (captureOnly) {
      bubble.classList.add('capture-only');
      bubble.textContent = capture?.status === 'complete'
        ? `실제 응답 캡처 · ${capture.filename || 'PNG 저장됨'}`
        : capture?.status === 'failed'
          ? '실제 응답 캡처 실패 · 실패 단계에서 다시 시도할 수 있어요.'
          : '실제 응답 캡처를 저장하는 중…';
      if (Number.isInteger(capture?.downloadId)) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'capture-open';
        open.textContent = '캡처 열기';
        open.addEventListener('click', async () => {
          try { await call('OPEN_SCREENSHOT', { downloadId: capture.downloadId }); }
          catch (error) { notice(error.message, true); }
        });
        bubble.append(open);
      }
    } else {
      bubble.textContent = entry.text || '';
    }
    item.append(meta, bubble);
    els.transcript.append(item);
  }
  requestAnimationFrame(() => { els.transcript.scrollTop = els.transcript.scrollHeight; });
}

function renderCaptures(model) {
  const { counts, items } = model.captures;
  els.captureSummary.textContent = counts.total ? `저장됨 ${counts.complete} / 전체 ${counts.total}` : '아직 없음';
  if (counts.failed) els.captureSummary.textContent += ` · 실패 ${counts.failed}`;
  els.captureList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'capture-empty';
    empty.textContent = '장면이 끝나면 실제 AI 응답 카드가 PNG로 저장됩니다.';
    els.captureList.append(empty);
    return;
  }
  for (const capture of items) {
    const row = document.createElement('article');
    row.className = 'capture-item';
    row.dataset.status = capture.status;
    const copy = document.createElement('div');
    copy.className = 'capture-copy';
    const dot = document.createElement('span');
    dot.className = 'capture-state-dot';
    const title = document.createElement('strong');
    title.textContent = `장면 ${capture.turnNumber || '?'} · ${capture.providerLabel}`;
    const meta = document.createElement('span');
    meta.textContent = capture.error || capture.label;
    copy.append(title, meta);
    row.append(dot, copy);
    if (Number.isInteger(capture.downloadId)) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'capture-open';
      open.textContent = '파일 열기';
      open.addEventListener('click', async () => {
        try { await call('OPEN_SCREENSHOT', { downloadId: capture.downloadId }); }
        catch (error) { notice(error.message, true); }
      });
      row.append(open);
    }
    els.captureList.append(row);
  }
}

function renderActivity() {
  els.activityLog.replaceChildren();
  const logs = meeting.activityLog || [];
  els.activityCount.textContent = String(logs.length);
  for (const log of logs.slice(-80).reverse()) {
    const row = document.createElement('div');
    row.className = `activity-item ${log.level === 'WARN' ? 'warn' : ''}`;
    const time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = new Date(log.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text = document.createElement('span');
    text.className = 'activity-message';
    text.textContent = log.stage ? `${log.stage} · ${log.message}` : log.message;
    row.append(time, text);
    els.activityLog.append(row);
  }
}

function renderAutopilot(model) {
  if (!els.plannerTab) return;
  const currentPlanner = Number(meeting?.autopilotRun?.plannerTabId) || Number(els.plannerTab.value) || 0;
  els.plannerTab.replaceChildren();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = supportedTabs.length ? '수동 설계 AI 탭 선택' : '자동 모드에서는 ChatGPT 탭을 직접 엽니다';
  els.plannerTab.append(empty);
  for (const tab of supportedTabs) {
    const option = document.createElement('option');
    option.value = String(tab.tabId);
    option.textContent = tab.label;
    option.selected = Number(tab.tabId) === currentPlanner;
    els.plannerTab.append(option);
  }
  const autopilot = model.autopilot;
  const run = meeting?.autopilotRun;
  const phase = autopilot?.phase || 'READY';
  const selectedParticipants = selectedAutopilotParticipants();
  const roleCount = Math.max(2, selectedParticipants.length);
  const boundTabCount = new Set(selectedParticipants.map((participant) => participant.tabId).filter(Number.isInteger)).size;
  els.autopilotPhase.textContent = autopilot?.phaseLabel || '대기';
  els.autopilotPhase.dataset.state = phase;
  const metrics = autopilot?.metrics || { expectedTurns: 0, maxTurns: 0, actualTurns: 0, successfulCaptures: 0, failedCaptures: 0, zipFiles: 0 };
  els.autopilotSummary.textContent = autopilot
    ? `${autopilot.planHash ? `plan ${autopilot.planHash.slice(0, 18)}… · ` : ''}예상 ${metrics.expectedTurns}턴 · 최대 ${metrics.maxTurns}턴 · 실제 ${metrics.actualTurns}턴 · 캡처 ${metrics.successfulCaptures}개 · 실패 ${metrics.failedCaptures}개 · ZIP ${metrics.zipFiles}개`
    : `자동 모드 · 키워드 하나로 설계 ChatGPT 탭과 역할 탭을 만들어요. 수동 탭 연결은 고급 설정에서 선택할 수 있어요.`;
  els.autopilotTimeline.replaceChildren();
  for (const event of (autopilot?.events || []).slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'autopilot-event';
    row.dataset.status = String(event.status || '').toLowerCase();
    const time = document.createElement('span');
    time.className = 'autopilot-event-time';
    time.textContent = event.at ? timeLabel(event.at) : '';
    const message = document.createElement('span');
    message.textContent = `${event.type || 'EVENT'} · ${event.message || event.status || ''}`;
    row.append(time, message);
    els.autopilotTimeline.append(row);
  }
  els.autopilotProviders.replaceChildren();
  for (const provider of (autopilot?.providers || [])) {
    const row = document.createElement('div');
    row.className = 'autopilot-provider';
    row.dataset.status = provider.injectionStatus;
    const identity = document.createElement('strong');
    identity.textContent = `${provider.roleId || 'role'} · scene ${provider.sceneIndex || '?'}`;
    const state = document.createElement('span');
    state.textContent = provider.injectionError || provider.injectionStatus;
    row.append(identity, state);
    els.autopilotProviders.append(row);
  }
  const artifact = meeting?.artifactSummary;
  els.artifactCard.replaceChildren();
  els.artifactCard.hidden = !artifact;
  if (artifact) {
    const heading = document.createElement('strong');
    heading.textContent = artifact.status === 'COMPLETE' ? 'ZIP 완료' : 'ZIP 확인 필요';
    const details = document.createElement('span');
    details.textContent = `${artifact.path || artifact.error || '파일 경로 없음'} · ${artifact.fileCount || 0} files · ${artifact.sizeBytes ? `${Math.round(artifact.sizeBytes / 1024)} KB` : ''}`;
    els.artifactCard.append(heading, details);
    if (Number.isInteger(artifact.downloadId)) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'artifact-open';
      open.textContent = 'ZIP 열기';
      open.addEventListener('click', async () => {
        try { await call('OPEN_ARTIFACT', { downloadId: artifact.downloadId }); }
        catch (error) { notice(error.message, true); }
      });
      els.artifactCard.append(open);
    }
  }
  const terminal = !run || ['COMPLETE', 'FAILED', 'CANCELLED'].includes(phase);
  const editable = isEditable();
  els.plannerTab.disabled = !editable || Boolean(run && !terminal);
  const hasAutoBrief = Boolean(els.projectKeyword?.value.trim() || els.composer?.value.trim());
  els.startAutopilot.disabled = !editable || (run && !terminal) || !hasAutoBrief;
  const meetingIsPaused = meeting?.status === 'PAUSED';
  const canResume = meetingIsPaused || Boolean(autopilot?.canResume);
  els.pauseAutopilot.disabled = !run || (!autopilot?.canPause && !canResume);
  els.pauseAutopilot.textContent = canResume ? '계속하기' : '일시정지';
  els.retryAutopilot.disabled = !run || !autopilot?.canRetry;
  els.stopAutopilot.disabled = !run || !autopilot?.canStop;
  els.resetAutopilot.disabled = !run || !autopilot?.canReset;
}

function renderSettings() {
  const settings = meeting.settings || {};
  const session = meeting.session || {};
  const editable = isEditable();
  els.maxTurns.value = settings.maxTurns ?? 20;
  els.delaySeconds.value = ((settings.minDelayMs ?? 4000) / 1000).toString();
  els.retryLimit.value = settings.retryLimit ?? 3;
  els.responseTimeout.value = Math.round((settings.responseTimeoutMs ?? 120000) / 1000);
  els.smartRouting.checked = settings.smartRouting !== false;
  els.captureScreenshots.checked = settings.captureScreenshots !== false;
  els.sessionTemplate.replaceChildren();
  for (const [value, label] of SESSION_OPTIONS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === (session.templateId || 'freeform');
    els.sessionTemplate.append(option);
  }
  els.sessionPhaseHint.textContent = session.status === 'COMPLETE'
    ? '장면 기록 완료'
    : `${session.status === 'RUNNING' ? '진행 중' : '대기'} · 단계 ${(Number(session.phaseIndex) || 0) + 1}`;
  els.loopGuardEnabled.checked = settings.loopGuardEnabled !== false;
  els.loopGuardInteractive.checked = settings.loopGuardInteractive === true;
  els.loopGuardMaxHops.value = settings.loopGuardMaxHops ?? 20;
  els.loopGuardMaxSameSpeaker.value = settings.loopGuardMaxSameSpeaker ?? 3;
  els.loopGuardMaxSameRoute.value = settings.loopGuardMaxSameRoute ?? 6;
  for (const element of [els.sessionTemplate, els.loopGuardEnabled, els.loopGuardInteractive, els.loopGuardMaxHops, els.loopGuardMaxSameSpeaker, els.loopGuardMaxSameRoute]) {
    element.disabled = !editable;
  }
  els.clearTranscript.disabled = !editable;
  els.newMeeting.disabled = !editable;
}

function renderAttention(model) {
  const guardPause = meeting.status === 'PAUSED' && Boolean(meeting.loopGuard?.lastReason);
  els.attentionStrip.hidden = !(model.actions.needsAttention || guardPause);
  els.attentionMessage.textContent = guardPause
    ? meeting.loopGuard.lastReason
    : (meeting.activeTransaction?.error || '장면을 이어가려면 아래에서 하나를 선택하세요.');
  els.retryTransaction.disabled = guardPause;
  els.skipParticipant.disabled = guardPause;
  els.reconnectParticipant.disabled = guardPause;
}

function renderProject(model) {
  const project = model.project;
  const editable = isEditable();
  if (project && document.activeElement !== els.projectKeyword) els.projectKeyword.value = project.keyword;
  els.projectKeyword.disabled = !editable;
  els.buildProject.disabled = !editable || !els.projectKeyword.value.trim();
  els.projectPlan.hidden = !project;
  els.sceneList.replaceChildren();
  if (!project) {
    els.projectApproval.textContent = '설계 필요';
    els.approveProjectRun.disabled = true;
    els.projectSummary.textContent = '';
    return;
  }

  els.projectApproval.textContent = project.approval.approved ? '실행 승인됨' : '검토 후 승인';
  els.projectApproval.dataset.approved = String(project.approval.approved);
  els.projectSummary.textContent = `${project.title} · ${project.sceneCount}개 장면 · 예상 ${project.totalExpectedTurns}턴 · 최대 ${project.totalMaxTurns}턴`;
  for (const scene of project.scenes) {
    const card = document.createElement('article');
    card.className = 'scene-card';
    card.dataset.current = String(scene.index === project.currentSceneIndex);
    const heading = document.createElement('div');
    heading.className = 'scene-card-heading';
    const number = document.createElement('span');
    number.className = 'scene-number';
    number.textContent = String(scene.number).padStart(2, '0');
    const title = document.createElement('strong');
    title.textContent = scene.title;
    heading.append(number, title);
    const goal = document.createElement('p');
    goal.textContent = scene.goal || scene.summary;
    const meta = document.createElement('span');
    meta.className = 'scene-card-meta';
    meta.textContent = `예상 ${scene.targetTurns}턴 · 최대 ${scene.maxTurns}턴 · 감정 ${scene.emotionIntensity}`;
    const ending = document.createElement('small');
    ending.textContent = `종료: ${scene.endCondition || '자연스러운 결론'}`;
    card.append(heading, goal, meta, ending);
    els.sceneList.append(card);
  }
  els.approveProjectRun.disabled = project.approval.approved || !editable;
  els.approveProjectRun.textContent = project.approval.approved ? '실행 승인됨' : '이 설계로 실행 승인';
}

function renderControls(model) {
  const status = model.status.key;
  const autonomous = model.mode.key === 'autonomous';
  const autopilotLocked = autopilotIsActive();
  if (els.sceneProgress) {
    els.sceneProgress.textContent = model.project?.currentScene
      ? `장면 ${model.project.currentScene.number}/${model.project.sceneCount} · ${model.project.currentScene.sceneTurnCount}/${model.project.currentScene.targetTurns}턴 · 최대 ${model.project.currentScene.maxTurns}턴`
      : '';
  }
  els.meetingStatus.textContent = model.status.label;
  els.meetingStatus.dataset.status = status;
  if (document.activeElement !== els.meetingTitle) els.meetingTitle.value = model.title;
  if (document.activeElement !== els.composer && !meeting.transcript.length) els.composer.value = model.topic;
  els.turnCounter.textContent = `${model.currentTurn}회`;
  els.interactionMode.dataset.mode = model.mode.key;
  els.interactiveMode.setAttribute('aria-pressed', String(!autonomous));
  els.autonomousMode.setAttribute('aria-pressed', String(autonomous));
  els.interactiveMode.disabled = autopilotLocked || !model.actions.canChangeMode;
  els.autonomousMode.disabled = autopilotLocked || !model.actions.canChangeMode;
  els.modeHint.textContent = autonomous
    ? (status === 'LIVE' ? '자동 진행 중… 잠시 지켜보고 있어요.' : '자동 진행: AI들이 장면을 이어가요.')
    : '직접 진행: 필요할 때 내 말을 넣을 수 있어요.';
  els.interactionMode.closest('.run-card').dataset.observer = String(autonomous && status === 'LIVE');
  els.composer.disabled = autopilotLocked || (autonomous && status === 'LIVE');
  els.sendUserMessage.disabled = autopilotLocked || (autonomous && status === 'LIVE');
  els.composer.placeholder = autonomous && status === 'LIVE' ? '자동 진행 중에는 잠시 기다려주세요.' : '장면의 상황과 감정을 적어주세요…';
  els.joinConversation.hidden = autopilotLocked || !(autonomous && status === 'PAUSED' && !meeting.activeTransaction);
  els.meetingTitle.disabled = autopilotLocked;
  els.startMeeting.disabled = autopilotLocked || status === 'LIVE' || Boolean(model.project && !model.project.approval.approved);
  if (model.project && !model.project.approval.approved && status !== 'LIVE') {
    els.startMeeting.title = '프로젝트 설계 승인 후 시작할 수 있어요.';
  } else {
    els.startMeeting.removeAttribute('title');
  }
  els.startMeeting.textContent = status === 'PAUSED' ? '장면 계속하기' : (status === 'FINISHED' ? '새 장면 시작' : '장면 시작');
  els.pauseMeeting.disabled = autopilotLocked || !['LIVE', 'PAUSED'].includes(status);
  els.pauseMeeting.textContent = status === 'PAUSED' ? '계속하기' : '일시정지';
  els.endMeeting.disabled = autopilotLocked || status === 'FINISHED' || status === 'READY';
}

function render() {
  if (!meeting) return;
  const model = buildYouTubeSurfaceModel(meeting, screenshotJobs);
  renderProject(model);
  renderControls(model);
  renderParticipants(model);
  renderTranscript(model);
  renderCaptures(model);
  renderActivity();
  renderAutopilot(model);
  renderSettings();
  renderAttention(model);
  renderFocusState(model);
}

function runFocusAction() {
  const target = els.focusAction?.dataset.target || '';
  if (target === 'scrollDesign') return $('designWorkspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (target === 'scrollRun') return $('conversationWorkspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (target === 'scrollOutput') return $('outputWorkspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const control = els[target];
  if (control && typeof control.click === 'function') control.click();
}

async function refreshTabs(showNotice = true) {
  try {
    const result = await call('LIST_SUPPORTED_TABS');
    supportedTabs = result.tabs || [];
    if (showNotice) notice(supportedTabs.length ? `${supportedTabs.length}개 AI 탭을 찾았어요.` : '열린 AI 탭이 없어요.');
  } catch (error) {
    notice(error.message, true);
  }
}

function syncCapturePolling() {
  const pending = screenshotJobs.some((job) => ['pending', 'capturing', 'retry'].includes(String(job.status).toLowerCase()));
  if (pending && !capturePollTimer) capturePollTimer = setInterval(() => refreshCaptureJobs(false).catch(() => {}), 1500);
  if (!pending && capturePollTimer) {
    clearInterval(capturePollTimer);
    capturePollTimer = null;
  }
}

async function refreshCaptureJobs(renderAfter = true) {
  if (captureRefreshInFlight) return;
  captureRefreshInFlight = true;
  try {
    const result = await call('LIST_SCREENSHOT_JOBS');
    screenshotJobs = Array.isArray(result.jobs) ? result.jobs : [];
    syncCapturePolling();
    if (renderAfter) render();
  } finally {
    captureRefreshInFlight = false;
  }
}

async function chooseInteractionMode(mode) {
  try {
    await call('SET_INTERACTION_MODE', { mode });
    render();
  } catch (error) {
    notice(error.message, true);
  }
}

async function sendComposer() {
  const text = els.composer.value.trim();
  if (!text) return;
  if (meeting.interactionMode === 'autonomous' && meeting.status === 'LIVE') {
    notice('자동 진행 중에는 잠시 멈춘 뒤 말을 넣어주세요.', true);
    return;
  }
  try {
    await call('USER_MESSAGE', { text });
    els.composer.value = '';
    notice(meeting.status === 'READY' ? '아이디어를 넣었어요. 장면 시작을 눌러주세요.' : '장면에 말을 넣었어요.');
    render();
  } catch (error) {
    notice(error.message, true);
  }
}

async function updateSettings() {
  try {
    await call('UPDATE_MEETING_SETTINGS', { settings: {
      maxTurns: Number(els.maxTurns.value),
      minDelayMs: Number(els.delaySeconds.value) * 1000,
      retryLimit: Number(els.retryLimit.value),
      responseTimeoutMs: Number(els.responseTimeout.value) * 1000,
      smartRouting: els.smartRouting.checked,
      captureScreenshots: els.captureScreenshots.checked,
    } });
    render();
  } catch (error) {
    notice(error.message, true);
  }
}

async function updateLoopGuard() {
  try {
    await call('UPDATE_LOOP_GUARD', { settings: {
      loopGuardEnabled: els.loopGuardEnabled.checked,
      loopGuardInteractive: els.loopGuardInteractive.checked,
      loopGuardMaxHops: Number(els.loopGuardMaxHops.value),
      loopGuardMaxSameSpeaker: Number(els.loopGuardMaxSameSpeaker.value),
      loopGuardMaxSameRoute: Number(els.loopGuardMaxSameRoute.value),
    } });
    render();
  } catch (error) {
    notice(error.message, true);
  }
}

els.refreshTabs.addEventListener('click', async () => { await refreshTabs(); render(); });
els.focusAction?.addEventListener('click', runFocusAction);
els.openAiTabs?.addEventListener('click', async () => {
  const providers = [...(els.aiProviderChoices?.querySelectorAll('input[type="checkbox"]:checked') || [])].map((input) => input.value);
  if (!providers.length) {
    notice('열 AI를 하나 이상 선택하세요.', true);
    return;
  }
  els.openAiTabs.disabled = true;
  try {
    const result = await call('OPEN_AI_TABS', { providers });
    const openedTabs = Array.isArray(result.tabs) ? result.tabs.filter((tab) => Number.isInteger(Number(tab?.tabId))) : [];
    await refreshTabs(false);
    if (openedTabs.length) {
      const openedIds = new Set(openedTabs.map((tab) => Number(tab.tabId)));
      supportedTabs = [...supportedTabs.filter((tab) => !openedIds.has(Number(tab.tabId))), ...openedTabs];
      const plannerValue = String(els.plannerTab.value || '').trim();
      if (!plannerValue) els.plannerTab.value = String(openedTabs[0].tabId);
    }
    render();
    const labels = (result.tabs || []).map((tab) => `${tab.providerLabel || tab.provider}${tab.reused ? ' 재사용' : ' 열림'}`).join(', ');
    const failures = Array.isArray(result.errors) && result.errors.length ? ` 실패: ${result.errors.join(' · ')}` : '';
    notice(`${labels || 'AI 탭'} 준비됐어요. 캐릭터 카드 연결을 확인하세요.${failures}`, Boolean(failures));
  } catch (error) {
    notice(error.message, true);
  } finally {
    els.openAiTabs.disabled = false;
  }
});
els.projectKeyword.addEventListener('input', () => {
  els.buildProject.disabled = !isEditable() || !els.projectKeyword.value.trim();
  if (els.startAutopilot) els.startAutopilot.disabled = !isEditable() || !els.projectKeyword.value.trim();
});
els.composer.addEventListener('input', () => {
  if (els.projectKeyword.value.trim() || !els.startAutopilot) return;
  els.startAutopilot.disabled = !isEditable() || !els.composer.value.trim();
});
els.buildProject.addEventListener('click', async () => {
  const keyword = els.projectKeyword.value.trim();
  if (!keyword) return;
  try {
    await call('BUILD_PROJECT_PLAN', { keyword });
    screenshotJobs = [];
    render();
    notice('전체 장면을 만들었어요. 내용을 확인한 뒤 실행을 승인하세요.');
  } catch (error) {
    notice(error.message, true);
  }
});
els.startAutopilot?.addEventListener('click', async () => {
  const projectBrief = els.projectKeyword.value.trim() || els.composer.value.trim();
  if (!projectBrief) return notice('프로젝트 한 단어 또는 설명을 먼저 입력하세요.', true);
  const hasExisting = Boolean(meeting?.projectPlan || meeting?.autopilotRun);
  if (hasExisting && !window.confirm('현재 프로젝트를 새 V2 프로젝트로 교체할까요?')) return;
  try {
    await call('START_AUTOPILOT', { projectBrief, language: 'ko', autoProvision: true, replaceConfirmed: true });
    els.composer.value = '';
    notice('새 ChatGPT 설계 탭을 열고 역할 탭까지 자동으로 준비합니다.');
    render();
  } catch (error) {
    notice(error.message, true);
  }
});
els.pauseAutopilot?.addEventListener('click', async () => {
  try {
    const meetingIsPaused = meeting?.status === 'PAUSED';
    if (meetingIsPaused || ['PAUSED', 'CANCELLED'].includes(meeting?.autopilotRun?.state)) await call('RESUME_AUTOPILOT');
    else await call('PAUSE_AUTOPILOT');
    render();
  } catch (error) { notice(error.message, true); }
});
els.retryAutopilot?.addEventListener('click', async () => {
  try {
    await call('RETRY_AUTOPILOT');
    render();
    notice('실패한 단계만 다시 시도하고 있어요.');
  } catch (error) { notice(error.message, true); }
});
els.stopAutopilot?.addEventListener('click', async () => {
  try { await call('STOP_AUTOPILOT'); render(); notice('자동 실행을 중지했어요. 검증된 캡처는 보존됩니다.'); }
  catch (error) { notice(error.message, true); }
});
els.resetAutopilot?.addEventListener('click', async () => {
  try {
    await call('RESET_AUTOPILOT');
    screenshotJobs = [];
    render();
    notice('자동 실행을 초기화했어요. 새 프로젝트를 시작할 수 있습니다.');
  } catch (error) { notice(error.message, true); }
});
els.approveProjectRun.addEventListener('click', async () => {
  try {
    await call('APPROVE_PROJECT_RUN', { scope: 'all' });
    render();
    notice('프로젝트 실행을 승인했어요. 이제 장면을 시작할 수 있어요.');
  } catch (error) {
    notice(error.message, true);
  }
});
els.addParticipant.addEventListener('click', async () => {
  try { await call('ADD_PARTICIPANT'); render(); }
  catch (error) { notice(error.message, true); }
});
els.interactiveMode.addEventListener('click', () => chooseInteractionMode('interactive'));
els.autonomousMode.addEventListener('click', () => chooseInteractionMode('autonomous'));
els.joinConversation.addEventListener('click', () => chooseInteractionMode('interactive'));

els.startMeeting.addEventListener('click', async () => {
  try {
    if (meeting.projectPlan && meeting.projectPlan.approval?.approved !== true) {
      notice('프로젝트 설계를 먼저 승인하세요.', true);
      return;
    }
    if (meeting.status === 'PAUSED') {
      await call('RESUME_MEETING');
    } else if (meeting.status === 'FINISHED' && meeting.projectPlan?.keyword) {
      await call('BUILD_PROJECT_PLAN', { keyword: meeting.projectPlan.keyword });
      screenshotJobs = [];
      notice('새 프로젝트 설계를 만들었어요. 내용을 확인한 뒤 다시 승인하세요.');
    } else if (meeting.status === 'FINISHED') {
      await call('NEW_MEETING', { options: { title: meeting.title, interactionMode: meeting.interactionMode, session: { templateId: meeting.session?.templateId || 'freeform' } } });
      await refreshTabs(false);
      screenshotJobs = [];
      notice('새 장면을 만들었어요. AI 탭을 다시 연결해주세요.');
    } else {
      const seedText = els.composer.value.trim();
      await call('START_MEETING', { seedText, mode: meeting.interactionMode || 'interactive' });
      if (seedText) els.composer.value = '';
      notice('장면을 시작했어요.');
    }
    render();
    await refreshCaptureJobs(false);
  } catch (error) {
    notice(error.message, true);
  }
});

els.pauseMeeting.addEventListener('click', async () => {
  try { await call(meeting.status === 'PAUSED' ? 'RESUME_MEETING' : 'PAUSE_MEETING'); render(); }
  catch (error) { notice(error.message, true); }
});
els.endMeeting.addEventListener('click', async () => {
  try { await call('END_MEETING'); render(); await refreshCaptureJobs(false); }
  catch (error) { notice(error.message, true); }
});
els.sendUserMessage.addEventListener('click', sendComposer);
els.composer.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendComposer();
  }
});
els.retryTransaction.addEventListener('click', async () => {
  try { await call('RETRY_TRANSACTION'); render(); }
  catch (error) { notice(error.message, true); }
});
els.skipParticipant.addEventListener('click', async () => {
  try { await call('SKIP_PARTICIPANT'); render(); }
  catch (error) { notice(error.message, true); }
});
els.reconnectParticipant.addEventListener('click', async () => {
  try { await call('RECONNECT_PARTICIPANT'); render(); }
  catch (error) { notice(`${error.message} 캐릭터 카드에서 다른 AI 탭을 선택해보세요.`, true); }
});

for (const element of [els.maxTurns, els.delaySeconds, els.retryLimit, els.responseTimeout, els.smartRouting, els.captureScreenshots]) {
  element.addEventListener('change', updateSettings);
}
for (const element of [els.loopGuardEnabled, els.loopGuardInteractive, els.loopGuardMaxHops, els.loopGuardMaxSameSpeaker, els.loopGuardMaxSameRoute]) {
  element.addEventListener('change', updateLoopGuard);
}
els.sessionTemplate.addEventListener('change', async () => {
  try { await call('UPDATE_SESSION_TEMPLATE', { templateId: els.sessionTemplate.value }); render(); }
  catch (error) { notice(error.message, true); }
});
els.clearTranscript.addEventListener('click', async () => {
  try { await call('CLEAR_TRANSCRIPT'); render(); await refreshCaptureJobs(false); }
  catch (error) { notice(error.message, true); }
});
els.newMeeting.addEventListener('click', async () => {
  try { await call('NEW_MEETING', { options: { title: '새 쇼츠 장면' } }); screenshotJobs = []; await refreshTabs(false); render(); notice('새 장면을 만들었어요.'); }
  catch (error) { notice(error.message, true); }
});
els.meetingTitle.addEventListener('input', () => {
  clearTimeout(titleSaveTimer);
  titleSaveTimer = setTimeout(async () => {
    try { await call('UPDATE_MEETING_TITLE', { title: els.meetingTitle.value.trim() || '새 쇼츠 장면' }); }
    catch (error) { notice(error.message, true); }
  }, 450);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'MEETING_STATE_CHANGED' && message.meeting) {
    meeting = message.meeting;
    render();
    refreshCaptureJobs(false).catch(() => {});
  }
});

async function load() {
  try {
    const [state, tabs, captures] = await Promise.all([
      call('GET_MEETING_STATE'),
      call('LIST_SUPPORTED_TABS'),
      call('LIST_SCREENSHOT_JOBS'),
    ]);
    meeting = state.meeting;
    supportedTabs = tabs.tabs || [];
    screenshotJobs = captures.jobs || [];
    syncCapturePolling();
    render();
  } catch (error) {
    notice(error.message, true);
  }
}

load();

// Keep the service worker checking provider tabs even while the user browses elsewhere.
setInterval(() => {
  if (!meeting?.activeTransaction || !['LIVE', 'PAUSED', 'NEEDS_ATTENTION'].includes(meeting.status)) return;
  chrome.runtime.sendMessage({ type: 'CHECK_ACTIVE_TURN' }).catch(() => {});
}, 1800);

setInterval(() => refreshTabs(false).then(() => {
  if (document.activeElement?.tagName !== 'SELECT') renderParticipants(buildYouTubeSurfaceModel(meeting || {}, screenshotJobs));
}).catch(() => {}), 8000);
