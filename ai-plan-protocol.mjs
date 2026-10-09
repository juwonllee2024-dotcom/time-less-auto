export const PLAN_MARKERS = Object.freeze({
  begin: 'TLA_PLAN_V2_BEGIN',
  end: 'TLA_PLAN_V2_END',
});

const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'requestId',
  'requestNonce',
  'project',
  'roles',
  'scenes',
  'runPolicy',
  'capturePolicy',
]);

const SAFE_MODES = new Set(['autonomous', 'interactive']);
const TURN_UNIT = 'provider_response';
const CAPTURE_MODE = 'actual_response_only';
const MAX_PLAN_CHARS = 160000;

function text(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function error(code, path, message) {
  return { code, path, message };
}

function requiredString(value, path, errors, max = 1000) {
  const normalized = text(value, max);
  if (!normalized) errors.push(error('REQUIRED', path, `${path} is required.`));
  return normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unsafeText(value) {
  return /(api[_ -]?key|password|secret|access[_ -]?token|<script|javascript:)/i.test(String(value || ''));
}

function checkUnsafeValue(value, path, errors) {
  if (typeof value === 'string') {
    if (unsafeText(value)) errors.push(error('UNSAFE_FIELD', path, `${path} contains a credential or executable-looking value.`));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkUnsafeValue(item, `${path}[${index}]`, errors));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) checkUnsafeValue(item, `${path}.${key}`, errors);
  }
}

function integer(value) {
  return Number.isInteger(value) ? value : Number.isInteger(Number(value)) ? Number(value) : null;
}

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rightRotate(value, bits) { return (value >>> bits) | (value << (32 - bits)); }

function stablePlanHash(value = '') {
  const input = new TextEncoder().encode(String(value));
  const bitLength = input.length * 8;
  const totalLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(totalLength - 4, bitLength >>> 0);
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return `sha256:${[h0, h1, h2, h3, h4, h5, h6, h7].map((part) => part.toString(16).padStart(8, '0')).join('')}`;
}

function exactKeys(value, expected, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(error('OBJECT_REQUIRED', path, `${path} must be an object.`));
    return;
  }
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(error('UNKNOWN_FIELD', `${path}.${key}`, `${path}.${key} is not allowed.`));
  }
}

export function buildPlanPrompt({ projectBrief, roleHints = '', roleSlots = [], requestId, requestNonce, language = 'ko', autoRoleProvisioning = false } = {}) {
  const brief = text(projectBrief, 4000);
  const hints = text(roleHints, 1800) || '(none)';
  const slots = Array.isArray(roleSlots) ? roleSlots.slice(0, 6) : [];
  const slotCount = Math.max(2, slots.length || 0);
  const autoRoleMode = autoRoleProvisioning === true && slots.length === 0;
  const slotContract = slots.length
    ? [
      `ROLE_SLOT_COUNT: ${slotCount}`,
      'ROLE_SLOTS (hard contract; preserve order, ids, and explicit guidance):',
      ...slots.map((slot, index) => `ROLE_SLOT_${index + 1}: id=${text(slot?.roleId, 80) || `role-${index + 1}`}; role=${text(slot?.role, 180) || '(AI may name this slot)'}; guidance=${text(slot?.rolePrompt || slot?.roleGuidance, 360) || '(AI may complete guidance)'}`),
    ].join('\n')
    : autoRoleMode
      ? 'ROLE_SLOT_COUNT: AI_CHOICE\nROLE_SLOT_RANGE: 2..6\nROLE_SLOTS: no preconfigured slots; choose the role count and define every role.'
    : 'ROLE_SLOT_COUNT: 2\nROLE_SLOTS: no custom slots supplied; create exactly two roles.';
  const id = text(requestId, 120);
  const nonce = text(requestNonce, 180);
  if (!brief) throw new Error('A project brief is required.');
  if (!id || !nonce) throw new Error('requestId and requestNonce are required.');
  return [
    'You are the Time Less Auto V2 project-plan generator.',
    '',
    'Create exactly one executable roleplay project from the project brief below.',
    'Do not discuss your process. Do not use markdown. Do not output prose outside the markers.',
    '',
    `OUTPUT_LANGUAGE: ${text(language, 40) || 'ko'}`,
    `PROJECT_BRIEF: ${brief}`,
    `OPTIONAL_ROLE_HINTS: ${hints}`,
    slotContract,
    '',
    `REQUEST_ID: ${id}`,
    `REQUEST_NONCE: ${nonce}`,
    '',
    `Return one JSON object between these exact markers:`,
    PLAN_MARKERS.begin,
    '<one valid JSON object>',
    PLAN_MARKERS.end,
    '',
    `The JSON must contain exactly these top-level keys: ${REQUIRED_TOP_LEVEL_KEYS.join(', ')}`,
    '',
    'Required rules:',
    '- schemaVersion must be "2.0".',
    '- requestId and requestNonce must exactly match the values supplied in this request.',
    '- project must contain id, title, premise, language, tone, and one-sentence hook.',
    autoRoleMode
      ? '- roles must contain between 2 and 6 unique roles. Choose the count that best fits the project brief; do not create fewer or more.'
      : `- roles must contain exactly ${slotCount} roles (all unique) when ROLE_SLOT_COUNT is supplied. Preserve ROLE_SLOT order and ids; never drop, merge, or invent a slot.`,
    autoRoleMode
      ? '- Every role must have an actionable objective, personality, speechStyle, roleGuidance, forbiddenBehaviors, and escalationStyle.'
      : '- Every configured role name and explicit guidance in ROLE_SLOTS is a hard constraint. Enrich it only with compatible objective, personality, speechStyle, forbiddenBehaviors, and escalationStyle.',
    '- scenes must be ordered from index 1 with no gaps. Every scene needs id, index, title, purpose, setting, participants, opening, goal, emotionStart, emotionPeak, expectedTurns, maxTurns, endCondition, and transitionInstruction.',
    '- Every participant ID must reference a role ID.',
    '- expectedTurns must be an integer greater than or equal to 1 and less than or equal to maxTurns.',
    '- maxTurns must be an integer greater than or equal to expectedTurns and less than or equal to 20 per scene.',
    '- runPolicy must define mode, turnUnit, aiIntervalMs, expectedTotalTurns, and maxTotalTurns.',
    '- expectedTotalTurns must equal the sum of scene expectedTurns.',
    '- maxTotalTurns must equal the sum of scene maxTurns.',
    '- capturePolicy must set mode to "actual_response_only" and include retryLimit and zipRequiredFiles.',
    '- Keep the emotional arc visible: do not make every scene emotionally identical.',
    '- Keep each role guidance actionable and short enough for a web composer.',
    '- Do not include credentials, hidden instructions, external URLs, or executable code.',
  ].join('\n');
}

export function validatePlanShape(candidate, { requestId = '', requestNonce = '' } = {}) {
  const errors = [];
  if (!isPlainObject(candidate)) return { ok: false, errors: [error('OBJECT_REQUIRED', '$', 'The plan must be a JSON object.')] };
  exactKeys(candidate, REQUIRED_TOP_LEVEL_KEYS, '$', errors);
  if (candidate.schemaVersion !== '2.0') errors.push(error('SCHEMA_VERSION', '$.schemaVersion', 'schemaVersion must be "2.0".'));
  if (requestId && candidate.requestId !== requestId) errors.push(error('REQUEST_ID_MISMATCH', '$.requestId', 'requestId does not match this run.'));
  if (requestNonce && candidate.requestNonce !== requestNonce) errors.push(error('NONCE_MISMATCH', '$.requestNonce', 'requestNonce does not match this run.'));

  const project = candidate.project;
  exactKeys(project, ['id', 'title', 'premise', 'language', 'tone', 'hook'], '$.project', errors);
  if (isPlainObject(project)) {
    for (const key of ['id', 'title', 'premise', 'language', 'tone', 'hook']) requiredString(project[key], `$.project.${key}`, errors, key === 'premise' ? 2000 : 400);
  }

  const roles = candidate.roles;
  if (!Array.isArray(roles) || roles.length < 2) {
    errors.push(error('ROLES_REQUIRED', '$.roles', 'At least two roles are required.'));
  }
  if (Array.isArray(roles) && roles.length > 6) errors.push(error('ROLES_LIMIT', '$.roles', 'At most six roles are supported.'));
  const roleIds = new Set();
  if (Array.isArray(roles)) {
    roles.forEach((role, index) => {
      const path = `$.roles[${index}]`;
      exactKeys(role, ['id', 'name', 'objective', 'personality', 'speechStyle', 'roleGuidance', 'forbiddenBehaviors', 'escalationStyle'], path, errors);
      if (!isPlainObject(role)) return;
      const id = requiredString(role.id, `${path}.id`, errors, 80);
      if (id && roleIds.has(id)) errors.push(error('DUPLICATE_ROLE_ID', `${path}.id`, 'Role IDs must be unique.'));
      if (id) roleIds.add(id);
      for (const key of ['name', 'objective', 'personality', 'speechStyle', 'roleGuidance', 'escalationStyle']) requiredString(role[key], `${path}.${key}`, errors, 500);
      if (!Array.isArray(role.forbiddenBehaviors)) errors.push(error('ARRAY_REQUIRED', `${path}.forbiddenBehaviors`, 'forbiddenBehaviors must be an array.'));
      else role.forbiddenBehaviors.forEach((item, itemIndex) => requiredString(item, `${path}.forbiddenBehaviors[${itemIndex}]`, errors, 240));
    });
  }

  const scenes = candidate.scenes;
  if (!Array.isArray(scenes) || scenes.length < 1) errors.push(error('SCENES_REQUIRED', '$.scenes', 'At least one scene is required.'));
  const sceneIds = new Set();
  let expectedTotal = 0;
  let maxTotal = 0;
  if (Array.isArray(scenes)) {
    scenes.forEach((scene, index) => {
      const path = `$.scenes[${index}]`;
      exactKeys(scene, ['id', 'index', 'title', 'purpose', 'setting', 'participants', 'opening', 'goal', 'emotionStart', 'emotionPeak', 'expectedTurns', 'maxTurns', 'endCondition', 'transitionInstruction'], path, errors);
      if (!isPlainObject(scene)) return;
      const id = requiredString(scene.id, `${path}.id`, errors, 100);
      if (id && sceneIds.has(id)) errors.push(error('DUPLICATE_SCENE_ID', `${path}.id`, 'Scene IDs must be unique.'));
      if (id) sceneIds.add(id);
      const sceneIndex = integer(scene.index);
      if (sceneIndex !== index + 1) errors.push(error('SCENE_ORDER', `${path}.index`, 'Scene indexes must be contiguous and start at 1.'));
      for (const key of ['title', 'purpose', 'setting', 'opening', 'goal', 'emotionStart', 'emotionPeak', 'endCondition', 'transitionInstruction']) requiredString(scene[key], `${path}.${key}`, errors, 1200);
      if (!Array.isArray(scene.participants) || scene.participants.length < 2) errors.push(error('PARTICIPANTS_REQUIRED', `${path}.participants`, 'Each scene needs at least two participant IDs.'));
      else scene.participants.forEach((roleId, participantIndex) => {
        const normalizedRoleId = text(roleId, 80);
        if (!roleIds.has(normalizedRoleId)) errors.push(error('ROLE_REFERENCE', `${path}.participants[${participantIndex}]`, `Unknown role ID: ${normalizedRoleId}.`));
      });
      const expectedTurns = integer(scene.expectedTurns);
      const maxTurns = integer(scene.maxTurns);
      if (!Number.isInteger(expectedTurns) || expectedTurns < 1) errors.push(error('TURN_VALUE', `${path}.expectedTurns`, 'expectedTurns must be an integer >= 1.'));
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) errors.push(error('TURN_VALUE', `${path}.maxTurns`, 'maxTurns must be an integer between 1 and 20.'));
      if (Number.isInteger(expectedTurns) && Number.isInteger(maxTurns)) {
        if (expectedTurns > maxTurns) errors.push(error('TURN_ORDER', `${path}.expectedTurns`, 'expectedTurns cannot exceed maxTurns.'));
        expectedTotal += expectedTurns;
        maxTotal += maxTurns;
      }
    });
  }

  const runPolicy = candidate.runPolicy;
  exactKeys(runPolicy, ['mode', 'turnUnit', 'aiIntervalMs', 'expectedTotalTurns', 'maxTotalTurns'], '$.runPolicy', errors);
  if (isPlainObject(runPolicy)) {
    if (!SAFE_MODES.has(runPolicy.mode)) errors.push(error('RUN_MODE', '$.runPolicy.mode', 'mode must be autonomous or interactive.'));
    if (runPolicy.turnUnit !== TURN_UNIT) errors.push(error('TURN_UNIT', '$.runPolicy.turnUnit', `turnUnit must be ${TURN_UNIT}.`));
    const interval = integer(runPolicy.aiIntervalMs);
    if (!Number.isInteger(interval) || interval < 0 || interval > 300000) errors.push(error('INTERVAL_VALUE', '$.runPolicy.aiIntervalMs', 'aiIntervalMs must be an integer between 0 and 300000.'));
    if (integer(runPolicy.expectedTotalTurns) !== expectedTotal) errors.push(error('TOTAL_MISMATCH', '$.runPolicy.expectedTotalTurns', `expectedTotalTurns must equal ${expectedTotal}.`));
    if (integer(runPolicy.maxTotalTurns) !== maxTotal) errors.push(error('TOTAL_MISMATCH', '$.runPolicy.maxTotalTurns', `maxTotalTurns must equal ${maxTotal}.`));
    if (integer(runPolicy.expectedTotalTurns) > integer(runPolicy.maxTotalTurns)) errors.push(error('TOTAL_ORDER', '$.runPolicy.expectedTotalTurns', 'expectedTotalTurns cannot exceed maxTotalTurns.'));
  }

  const capturePolicy = candidate.capturePolicy;
  exactKeys(capturePolicy, ['mode', 'retryLimit', 'zipRequiredFiles'], '$.capturePolicy', errors);
  if (isPlainObject(capturePolicy)) {
    if (capturePolicy.mode !== CAPTURE_MODE) errors.push(error('CAPTURE_MODE', '$.capturePolicy.mode', `mode must be ${CAPTURE_MODE}.`));
    const retryLimit = integer(capturePolicy.retryLimit);
    if (!Number.isInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) errors.push(error('RETRY_VALUE', '$.capturePolicy.retryLimit', 'retryLimit must be an integer between 1 and 5.'));
    if (!Array.isArray(capturePolicy.zipRequiredFiles) || capturePolicy.zipRequiredFiles.some((item) => !text(item, 160))) errors.push(error('ZIP_REQUIRED_FILES', '$.capturePolicy.zipRequiredFiles', 'zipRequiredFiles must contain non-empty filenames.'));
  }

  checkUnsafeValue(candidate, '$', errors);
  const uniqueErrors = [];
  const seen = new Set();
  for (const item of errors) {
    const key = `${item.code}:${item.path}:${item.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueErrors.push(item);
    }
  }
  return { ok: uniqueErrors.length === 0, errors: uniqueErrors };
}

export function extractPlanEnvelope(responseText, expected = {}) {
  const source = String(responseText ?? '');
  const begin = PLAN_MARKERS.begin;
  const end = PLAN_MARKERS.end;
  const beginIndex = source.indexOf(begin);
  const endIndex = source.indexOf(end);
  const errors = [];
  if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) errors.push(error('MARKERS_MISSING', '$', `Response must contain ${begin} and ${end}.`));
  if (source.indexOf(begin, beginIndex + begin.length) >= 0 || source.indexOf(end, endIndex + end.length) >= 0) errors.push(error('MARKERS_MULTIPLE', '$', 'Response must contain one plan envelope.'));
  if (errors.length) return { ok: false, candidate: null, rawJson: '', errors };
  const rawJson = source.slice(beginIndex + begin.length, endIndex).trim();
  if (!rawJson || rawJson.length > MAX_PLAN_CHARS) return { ok: false, candidate: null, rawJson, errors: [error('PLAN_SIZE', '$', `Plan JSON must be between 1 and ${MAX_PLAN_CHARS} characters.`)] };
  let candidate;
  try {
    candidate = JSON.parse(rawJson);
  } catch (parseError) {
    return { ok: false, candidate: null, rawJson, errors: [error('JSON_INVALID', '$', `Plan JSON is invalid: ${parseError.message}`)] };
  }
  const validation = validatePlanShape(candidate, expected);
  return { ok: validation.ok, candidate, rawJson, errors: validation.errors };
}

// A provider can add an assistant card before its streamed text is complete.
// Keep polling until the end marker arrives or the non-streaming text is quiet
// for two polls, so a partial JSON prefix cannot trigger repair/injection.
export function planResponseGate({
  responseText = '',
  responseSignature = '',
  previousSignature = '',
  stablePolls = 0,
  generating = false,
  minStablePolls = 2,
} = {}) {
  const textValue = String(responseText ?? '').trim();
  if (!textValue) return { ready: false, stablePolls: 0, changed: false, hasEndMarker: false, signature: '' };
  const signature = String(responseSignature || textValue).trim();
  const previous = String(previousSignature || '').trim();
  const changed = !previous || signature !== previous;
  const nextStablePolls = changed ? 0 : Math.max(0, Number(stablePolls) || 0) + 1;
  const hasEndMarker = textValue.includes(PLAN_MARKERS.end);
  const quietLimit = Math.max(1, Number(minStablePolls) || 2);
  const ready = hasEndMarker || (!Boolean(generating) && nextStablePolls >= quietLimit);
  return { ready, stablePolls: nextStablePolls, changed, hasEndMarker, signature };
}

export function normalizeAiPlan(candidate, { keyword = '', requestId = '', requestNonce = '', now = Date.now() } = {}) {
  const validation = validatePlanShape(candidate, { requestId, requestNonce });
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const createdAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const project = candidate.project;
  const scenes = candidate.scenes.map((scene) => ({
    ...scene,
    index: scene.index - 1,
    summary: scene.purpose,
    targetTurns: scene.expectedTurns,
    emotionIntensity: scene.emotionPeak,
    transitionText: scene.transitionInstruction,
  }));
  const roles = candidate.roles.map((role) => ({
    ...role,
    label: role.name,
    role: role.name,
    rolePrompt: role.roleGuidance,
  }));
  const plan = {
    schemaVersion: '2.0',
    source: 'web-ai',
    requestId: requestId || candidate.requestId,
    requestNonce: requestNonce || candidate.requestNonce,
    id: project.id,
    keyword: text(keyword, 160) || project.title,
    title: project.title,
    premise: project.premise,
    hook: project.hook,
    language: project.language,
    tone: project.tone,
    project: { ...project },
    roles,
    scenes,
    runPolicy: { ...candidate.runPolicy },
    capturePolicy: { ...candidate.capturePolicy },
    currentSceneIndex: 0,
    sceneTurnCount: 0,
    status: 'DRAFT',
    approval: { approved: false, approvedAt: null, scope: 'all' },
    totalExpectedTurns: scenes.reduce((sum, scene) => sum + scene.expectedTurns, 0),
    totalMaxTurns: scenes.reduce((sum, scene) => sum + scene.maxTurns, 0),
    createdAt,
    updatedAt: createdAt,
  };
  plan.planHash = stablePlanHash(canonicalPlanJson(plan));
  return {
    ok: true,
    plan,
  };
}

export function buildPlanRepairPrompt({ candidateJson = '', errors = [], roleSlots = [], requestId, requestNonce, autoRoleProvisioning = false } = {}) {
  const safeCandidate = String(candidateJson || '').slice(0, MAX_PLAN_CHARS);
  const safeErrors = JSON.stringify(Array.isArray(errors) ? errors : [], null, 2);
  const slots = Array.isArray(roleSlots) ? roleSlots.slice(0, 6) : [];
  const slotContract = slots.length
    ? [
      `ROLE_SLOT_COUNT: ${slots.length}`,
      'ROLE_SLOTS (hard contract; preserve order, ids, and explicit guidance):',
      ...slots.map((slot, index) => `ROLE_SLOT_${index + 1}: id=${text(slot?.roleId, 80) || `role-${index + 1}`}; role=${text(slot?.role, 180) || '(AI may name this slot)'}; guidance=${text(slot?.rolePrompt || slot?.roleGuidance, 360) || '(AI may complete guidance)'}`),
    ].join('\n')
    : autoRoleProvisioning === true
      ? 'ROLE_SLOT_COUNT: AI_CHOICE\nROLE_SLOT_RANGE: 2..6\nROLE_SLOTS: choose and preserve 2~6 unique roles while fixing the listed errors.'
    : '';
  return [
    'TLA_PLAN_V2_REPAIR',
    `REQUEST_ID: ${text(requestId, 120)}`,
    `REQUEST_NONCE: ${text(requestNonce, 180)}`,
    'Return only the corrected JSON between TLA_PLAN_V2_BEGIN and TLA_PLAN_V2_END.',
    'Do not redesign valid fields. Fix only the listed validation errors.',
    'VALIDATION_ERRORS:',
    safeErrors,
    ...(autoRoleProvisioning === true && !slots.length ? ['The corrected plan must contain between 2 and 6 unique roles.'] : []),
    ...(slotContract ? [slotContract] : []),
    'CANDIDATE_JSON:',
    safeCandidate,
    PLAN_MARKERS.begin,
    '<corrected JSON>',
    PLAN_MARKERS.end,
  ].join('\n');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export function canonicalPlanJson(plan) {
  return JSON.stringify(sortValue(plan));
}

export { stablePlanHash };
