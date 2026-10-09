export const SCREENSHOT_MAX_ATTEMPTS = 3;
export const ASSISTANT_RESPONSE_CAPTURE_KIND = 'assistant-response';

const RETRY_DELAYS_MS = Object.freeze([250, 1000, 2000]);
const CARD_PADDING = 8;

function safeSegment(value, fallback = 'unknown') {
  const segment = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return segment || fallback;
}

function safeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function turnLabel(turnNumber) {
  return String(Math.max(0, Number(turnNumber) || 0)).padStart(3, '0');
}

function sceneLabel(sceneIndex) {
  return String(Math.max(1, Number(sceneIndex) || 1)).padStart(2, '0');
}

export function screenshotJobKey({ meetingId = '', transactionId = '', turnNumber = 0 } = {}) {
  return `${String(meetingId)}:${String(transactionId)}:${Number(turnNumber) || 0}`;
}

export function buildScreenshotFilename({ meetingId = '', provider = 'unknown', turnNumber = 0, timestamp = Date.now() } = {}) {
  const date = safeTimestamp(timestamp).replace(/[:.]/g, '-');
  return `time-less-auto-v1.0.0/screenshots/${safeSegment(meetingId)}/turn-${turnLabel(turnNumber)}_${safeSegment(provider)}_${date}.png`;
}

export function buildV2ScreenshotFilename({ sceneIndex = 1, turnNumber = 0, provider = 'unknown', roleId = 'role' } = {}) {
  return `screenshots/scene-${sceneLabel(sceneIndex)}-turn-${turnLabel(turnNumber)}-${safeSegment(provider)}-${safeSegment(roleId, 'role')}-response.png`;
}

export function createScreenshotJob({ meetingId, transactionId, participantId, tabId, provider, turnNumber, responseSignature = '', createdAt = Date.now(), version = '1.0.0', sceneIndex = 1, roleId = '' } = {}) {
  const v2 = String(version) === '2.0.0' || String(version).toLowerCase() === 'v2';
  const job = {
    key: screenshotJobKey({ meetingId, transactionId, turnNumber }),
    meetingId: String(meetingId || ''),
    transactionId: String(transactionId || ''),
    participantId: String(participantId || ''),
    tabId: Number(tabId),
    provider: safeSegment(provider),
    turnNumber: Number(turnNumber) || 0,
    sceneIndex: Math.max(1, Number(sceneIndex) || 1),
    roleId: safeSegment(roleId, ''),
    version: v2 ? '2.0.0' : '1.0.0',
    responseSignature: String(responseSignature || ''),
    filename: v2
      ? buildV2ScreenshotFilename({ sceneIndex, provider, turnNumber, roleId })
      : buildScreenshotFilename({ meetingId, provider, turnNumber, timestamp: createdAt }),
    createdAt: safeTimestamp(createdAt),
    updatedAt: safeTimestamp(createdAt),
    status: 'pending',
    attempts: 0,
    error: '',
    dataBase64: '',
    verified: false,
    captureKind: ASSISTANT_RESPONSE_CAPTURE_KIND,
    responseId: '',
  };
  return job;
}

export function enqueueScreenshotJob(queue = [], job) {
  const existing = (Array.isArray(queue) ? queue : []).find((item) => item?.key === job?.key);
  if (existing) return queue;
  return [...(Array.isArray(queue) ? queue : []), job];
}

export function markScreenshotJob(queue = [], key, patch = {}) {
  return (Array.isArray(queue) ? queue : []).map((job) => {
    if (job?.key !== key) return job;
    return { ...job, ...patch, updatedAt: safeTimestamp(patch.updatedAt || Date.now()) };
  });
}

export function nextScreenshotJob(queue = [], now = Date.now()) {
  return (Array.isArray(queue) ? queue : []).find((job) => {
    if (job?.status === 'pending') return true;
    if (job?.status === 'retry') return !job.nextAttemptAt || Number(job.nextAttemptAt) <= now;
    if (job?.status === 'capturing') {
      const updatedAt = Date.parse(job.updatedAt || '');
      return !Number.isFinite(updatedAt) || now - updatedAt > 30000;
    }
    return false;
  }) || null;
}

export function retryDelayMs(attempt = 1) {
  const index = Math.min(RETRY_DELAYS_MS.length - 1, Math.max(0, Number(attempt) - 1));
  return RETRY_DELAYS_MS[index];
}

export function normalizeResponseClip(rect) {
  if (!rect || !Number.isFinite(Number(rect.width)) || !Number.isFinite(Number(rect.height))) return null;
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (width <= 0 || height <= 0) return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const coordinateSpace = String(rect.coordinateSpace || '').trim().toLowerCase();
  if (coordinateSpace && !['document', 'viewport'].includes(coordinateSpace)) return null;
  return {
    x: Math.max(0, x - CARD_PADDING),
    y: Math.max(0, y - CARD_PADDING),
    width: width + CARD_PADDING * 2,
    height: height + CARD_PADDING * 2,
    scale: 1,
  };
}

/**
 * Validate the evidence returned by the provider content script before a
 * screenshot is persisted. This is deliberately fail-closed: a missing
 * assistant marker, response id, signature, text, or usable DOM rect must
 * never fall back to a visible-tab/full-page capture.
 */
export function validateResponseCapture({
  expectedSignature = '',
  responseSignature = '',
  responseText = '',
  captureKind = '',
  responseId = '',
  rect = null,
} = {}) {
  const expected = String(expectedSignature || '').trim();
  const reported = String(responseSignature || '').trim();
  const text = String(responseText || '').trim();
  const kind = String(captureKind || '').trim().toLowerCase();
  const id = String(responseId || '').trim();

  if (kind !== ASSISTANT_RESPONSE_CAPTURE_KIND) {
    return { ok: false, error: 'Only the assistant response card can be captured.' };
  }
  if (!expected) {
    return { ok: false, error: 'Expected assistant response signature is missing.' };
  }
  if (!reported || reported !== expected) {
    return { ok: false, error: 'Assistant response signature does not match the completed turn.' };
  }
  if (!text) {
    return { ok: false, error: 'Assistant response text is missing.' };
  }
  if (!id) {
    return { ok: false, error: 'Assistant response node identity is missing.' };
  }
  const coordinateSpace = String(rect?.coordinateSpace || '').trim().toLowerCase();
  if (!['document', 'viewport'].includes(coordinateSpace)) {
    return { ok: false, error: 'Assistant response card coordinate space is missing or invalid.' };
  }
  const clip = normalizeResponseClip(rect);
  if (!clip) {
    return { ok: false, error: 'Assistant response card bounds are invalid.' };
  }
  return {
    ok: true,
    captureKind: ASSISTANT_RESPONSE_CAPTURE_KIND,
    responseId: id,
    responseSignature: reported,
    responseText: text,
    clip,
  };
}
