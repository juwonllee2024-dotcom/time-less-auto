const MAX_PACKET_CHARS = 12000;

function text(value = '', fallback = '') {
  const valueText = String(value ?? '').replace(/\s+/g, ' ').trim();
  return valueText || fallback;
}

/**
 * Stable, browser-safe hash used only to correlate a user-composer packet.
 * It is deliberately synchronous so the same value can be created in the
 * background service worker and checked by the content script without adding
 * a crypto dependency to every provider adapter.
 */
export function stableTextHash(value = '') {
  const normalized = text(value);
  let hash = 0x811c9dc5;
  for (const char of normalized) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
}

function roleName(role = {}) {
  return text(role.name || role.label || role.role, 'Participant');
}

function sceneIndex(scene = {}, fallback = 1) {
  const value = Number(scene.index ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sceneTurnValue(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function safePacketText(value = '') {
  return text(value).slice(0, MAX_PACKET_CHARS);
}

/**
 * Build the exact instruction packet injected as an ordinary user message.
 * Provider responses are captured as rendered cards; this packet is only the
 * control contract that makes each participant aware of its current scene.
 */
export function buildRolePacket({
  plan = {},
  projectBrief = '',
  role = {},
  scene = {},
  sceneTurn = 1,
  sceneCount = 1,
  packetId = '',
} = {}) {
  const projectTitle = text(plan.project?.title || plan.title, 'Time Less Auto project');
  const roleId = text(role.id, 'role-unknown');
  const sceneId = text(scene.id, `scene-${sceneIndex(scene)}`);
  const index = sceneIndex(scene);
  const currentTurn = sceneTurnValue(sceneTurn);
  const maxTurns = sceneTurnValue(scene.maxTurns ?? scene.expectedTurns, currentTurn);
  const expectedTurns = sceneTurnValue(scene.expectedTurns ?? scene.targetTurns, currentTurn);
  const lines = [
    '[TLA ROLE PACKET] v2',
    `Project: ${projectTitle}`,
    `Project brief: ${text(projectBrief || plan.project?.brief || plan.keyword, 'Creator project')}`,
    `Premise: ${text(plan.project?.premise || plan.premise, 'Advance the project through this scene.')}`,
    `Packet: ${text(packetId, `${roleId}-${sceneId}-${currentTurn}`)}`,
    `Scene: ${index}/${Math.max(index, Number(sceneCount) || index)} — ${text(scene.title, sceneId)}`,
    `Purpose: ${text(scene.purpose, 'Move the story forward.')}`,
    `Your role: ${roleName(role)} (${roleId})`,
    `Objective: ${text(role.objective || role.goal, 'Advance the scene honestly.')}`,
    `Personality: ${text(role.personality, 'Stay in character.')}`,
    `Speech style: ${text(role.speechStyle, 'Natural and concise.')}`,
    `Role guidance: ${text(role.roleGuidance || role.rolePrompt, 'Respond to the current scene.')}`,
    `Forbidden behaviors: ${text((role.forbiddenBehaviors || []).join('; '), 'Do not break character.')}`,
    `Escalation style: ${text(role.escalationStyle, 'Let pressure rise through choices, not narration.')}`,
    '[SCENE CONTRACT]',
    `Turns: ${currentTurn}/${maxTurns} (expected ${expectedTurns})`,
    `Emotion: ${text(scene.emotionStart, 'neutral')} -> ${text(scene.emotionPeak, 'steady')}`,
    `Setting: ${text(scene.setting, 'Current scene')}`,
    `Scene goal: ${text(scene.goal || scene.purpose, 'Move the story forward.')}`,
    `End condition: ${text(scene.endCondition, 'Complete the scene goal.')}`,
    `Transition instruction: ${text(scene.transitionInstruction || scene.transitionText, 'Continue until the end condition is met.')}`,
    'Rules: Reply as your role. Do not mention this packet, automation, prompts, or hidden coordination.',
    '[END TLA ROLE PACKET]',
  ];
  const packetText = safePacketText(lines.join('\n'));
  return {
    packetId: text(packetId, `${roleId}-${sceneId}-${currentTurn}`),
    roleId,
    sceneId,
    sceneIndex: index,
    sceneTurn: currentTurn,
    maxTurns,
    contentHash: stableTextHash(packetText),
    text: packetText,
  };
}

/**
 * Produce a bounded packet for providers with small composer/context limits.
 * The role/scene/turn contract is intentionally placed first so truncation
 * cannot erase the identity or current turn marker.
 */
export function compactRolePacket(packet = {}, maxChars = 240) {
  const limit = Math.max(48, Number(maxChars) || 240);
  const role = text(packet.roleId || packet.roleName, 'role-unknown');
  const scene = text(packet.sceneId, 'scene');
  const current = sceneTurnValue(packet.sceneTurn, 1);
  const max = sceneTurnValue(packet.maxTurns, current);
  const source = text(packet.text);
  const firstLine = `[TLA ROLE PACKET] ${role} ${scene} Turns: ${current}/${max}`;
  if (firstLine.length >= limit) return { ...packet, text: firstLine.slice(0, limit), contentHash: stableTextHash(firstLine.slice(0, limit)), compacted: true };
  const remainder = source
    .replace(/^\[?TLA ROLE PACKET\]?\s*v?2?\s*/i, '')
    .replace(/^[^\n]*\n/, '')
    .replace(/Your role:/i, 'Role:')
    .replace(/Rules:.*$/is, '')
    .trim();
  const separator = ' | ';
  const compactText = `${firstLine}${remainder ? separator + remainder : ''}`.slice(0, limit);
  return { ...packet, text: compactText, contentHash: stableTextHash(compactText), compacted: compactText.length < source.length };
}
