const text = (value = '', max = 1000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function safeRunId(value = '') {
  return text(value, 160).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

export function artifactRootPath(runId) {
  return `time-less-auto-v2.0.0/runs/${safeRunId(runId)}`;
}

export function artifactZipFilename(runId) {
  return `${artifactRootPath(runId)}/${safeRunId(runId)}.zip`;
}

export function screenshotMembersFromJobs(jobs = []) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => String(job?.status || '').toLowerCase() === 'complete'
      && job?.verified === true
      && text(job?.filename)
      && text(job?.captureKind, 80) === 'assistant-response'
      && text(job?.responseId, 240))
    .map((job) => ({
      path: normalizeScreenshotPath(job.filename),
      dataBase64: String(job.dataBase64 || job.data || ''),
      verified: true,
      key: text(job.key, 300),
      turnNumber: Number(job.turnNumber) || 0,
      sceneIndex: Number(job.sceneIndex) || 1,
      provider: text(job.provider, 80),
      roleId: text(job.roleId, 120),
      captureKind: text(job.captureKind, 80),
      responseId: text(job.responseId, 240),
      responseSignature: text(job.responseSignature, 128),
      capturedAt: job.capturedAt || null,
    }));
}

function normalizeScreenshotPath(value) {
  const raw = text(value, 400).replace(/\\/g, '/');
  const marker = raw.indexOf('screenshots/');
  const path = marker >= 0 ? raw.slice(marker) : raw;
  if (!path.startsWith('screenshots/') || !path.toLowerCase().endsWith('.png') || path.includes('..')) throw new Error(`Invalid screenshot artifact path: ${value}`);
  return path;
}

export function buildManifest({ plan = {}, run = {}, bindings = [], screenshots = [], now = Date.now() } = {}) {
  const runId = text(run.runId, 160);
  const sourcePlan = plan && typeof plan === 'object' ? plan : {};
  return {
    artifactVersion: '2.0',
    schemaVersion: text(sourcePlan.schemaVersion, 20) || '2.0',
    runId,
    planHash: text(sourcePlan.planHash, 200),
    generatedAt: Number(now) || Date.now(),
    project: sourcePlan.project && typeof sourcePlan.project === 'object'
      ? sourcePlan.project
      : { id: text(sourcePlan.id, 120), title: text(sourcePlan.title, 200), premise: text(sourcePlan.premise, 800), language: text(sourcePlan.language, 40), tone: text(sourcePlan.tone, 120), hook: text(sourcePlan.hook, 300) },
    plan: sourcePlan,
    bindings: (Array.isArray(bindings) ? bindings : []).map((binding) => {
      const normalized = {
        roleId: text(binding?.roleId || binding?.role, 120),
        participantId: text(binding?.participantId, 160),
      };
      if (text(binding?.provider, 80)) normalized.provider = text(binding.provider, 80);
      if (Number.isInteger(Number(binding?.tabId))) normalized.tabId = Number(binding.tabId);
      return normalized;
    }),
    screenshots: (Array.isArray(screenshots) ? screenshots : []).map((shot) => ({
      path: normalizeScreenshotPath(shot?.path || shot?.filename),
      key: text(shot?.key, 300),
      verified: shot?.verified === true,
      turnNumber: Number(shot?.turnNumber) || 0,
      sceneIndex: Number(shot?.sceneIndex) || 1,
      provider: text(shot?.provider, 80),
      roleId: text(shot?.roleId, 120),
      captureKind: text(shot?.captureKind, 80),
      responseId: text(shot?.responseId, 240),
      responseSignature: text(shot?.responseSignature, 128),
      capturedAt: shot?.capturedAt || null,
    })),
  };
}

function countsFromRun(run = {}) {
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

export function buildRunReport({ run = {}, artifactSummary = null, now = Date.now() } = {}) {
  const source = run && typeof run === 'object' ? run : {};
  const events = Array.isArray(source.events) ? source.events : [];
  const failures = events.filter((event) => /fail|error|paused/i.test(`${event?.status || ''} ${event?.type || ''}`)).map((event) => ({
    at: event.at || null,
    type: text(event.type, 80),
    target: text(event.target, 160),
    message: text(event.message, 1000),
    metadata: event.metadata || {},
  }));
  return {
    reportVersion: '2.0',
    runId: text(source.runId, 160),
    state: text(source.state, 40) || 'UNKNOWN',
    generatedAt: Number(now) || Date.now(),
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
    plannerAttempt: Number(source.plannerAttempt) || 0,
    counts: countsFromRun(source),
    providers: source.providers && typeof source.providers === 'object' ? source.providers : {},
    events,
    failures,
    artifact: artifactSummary && typeof artifactSummary === 'object' ? artifactSummary : null,
  };
}

export function artifactCompleteness({ screenshots = [], expectedCaptures = null, requiredMembers = ['manifest.json', 'run-report.json', 'checksums.sha256'] } = {}) {
  const items = Array.isArray(screenshots) ? screenshots : [];
  const verified = items.filter((shot) => shot?.verified === true && text(shot?.path || shot?.filename)).length;
  const expected = expectedCaptures == null ? Math.max(1, verified) : Math.max(0, Number(expectedCaptures) || 0);
  const missing = [];
  for (const name of requiredMembers) if (!name) continue;
  if (verified < expected) missing.push(`screenshots (${verified}/${expected})`);
  return { complete: missing.length === 0 && verified > 0, missing, verifiedCaptures: verified };
}
