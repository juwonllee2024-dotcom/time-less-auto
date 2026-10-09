export const AUTO_PROVISION_PROVIDER = 'chatgpt';
export const AUTO_PROVISION_MIN_ROLES = 2;
export const AUTO_PROVISION_MAX_ROLES = 6;

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function roleCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return AUTO_PROVISION_MIN_ROLES;
  return Math.min(AUTO_PROVISION_MAX_ROLES, Math.max(AUTO_PROVISION_MIN_ROLES, Math.floor(number)));
}

export function normalizeAutoProvisionRequest(message = {}) {
  const plannerValue = String(message?.plannerTabId ?? '').trim();
  const hasPlannerSelection = plannerValue.length > 0 && Number.isInteger(Number(plannerValue));
  return {
    enabled: message?.autoProvision === true || (message?.autoProvision == null && !hasPlannerSelection),
    provider: AUTO_PROVISION_PROVIDER,
    reuseExisting: false,
    minRoles: AUTO_PROVISION_MIN_ROLES,
    maxRoles: AUTO_PROVISION_MAX_ROLES,
  };
}

export function createAutoTabManifest({ roleCount: requestedCount, provider = AUTO_PROVISION_PROVIDER } = {}) {
  const normalizedProvider = clean(provider, 40) || AUTO_PROVISION_PROVIDER;
  const count = roleCount(requestedCount);
  return [
    { kind: 'planner', provider: normalizedProvider, roleIndex: null },
    ...Array.from({ length: count }, (_, index) => ({ kind: 'role', provider: normalizedProvider, roleIndex: index })),
  ];
}

export function bindAutoRoleSlots({ roles = [], participants = [], tabs = [] } = {}) {
  if (!Array.isArray(roles) || roles.length < AUTO_PROVISION_MIN_ROLES) {
    throw new Error('Auto provisioning requires at least two roles.');
  }
  if (roles.length > AUTO_PROVISION_MAX_ROLES) {
    throw new Error(`Auto provisioning supports at most ${AUTO_PROVISION_MAX_ROLES} roles.`);
  }
  const validParticipants = Array.isArray(participants)
    ? participants.filter((participant) => clean(participant?.id, 160))
    : [];
  const validTabs = Array.isArray(tabs)
    ? tabs.filter((tab) => Number.isInteger(Number(tab?.tabId)) && Number(tab.tabId) > 0 && clean(tab?.provider, 40))
    : [];
  if (validParticipants.length < roles.length) throw new Error('Auto provisioning needs one participant card per role.');
  if (validTabs.length < roles.length) throw new Error('Auto provisioning needs at least two valid role tabs.');

  const selectedTabs = validTabs.slice(0, roles.length);
  const tabIds = new Set(selectedTabs.map((tab) => Number(tab.tabId)));
  if (tabIds.size !== selectedTabs.length) throw new Error('Auto role tabs must be unique.');
  const participantIds = new Set(validParticipants.slice(0, roles.length).map((participant) => clean(participant.id, 160)));
  if (participantIds.size !== roles.length) throw new Error('Auto role participants must be unique.');

  const roleSlots = roles.map((role = {}, index) => {
    const roleId = clean(role.id, 80) || `role-${index + 1}`;
    const participant = validParticipants[index];
    const tab = selectedTabs[index];
    const provider = clean(tab.provider, 40) || AUTO_PROVISION_PROVIDER;
    const label = clean(tab.label, 160) || `${provider} · ${clean(role.name || role.role, 120) || roleId}`;
    return {
      roleId,
      roleIndex: index,
      participantId: clean(participant.id, 160),
      tabId: Number(tab.tabId),
      provider,
      label,
      role: clean(role.role || role.name || role.label, 240),
      rolePrompt: clean(role.rolePrompt || role.roleGuidance, 500),
    };
  });
  return {
    roleSlots,
    bindings: roleSlots.map((slot) => ({
      participantId: slot.participantId,
      roleId: slot.roleId,
      roleIndex: slot.roleIndex,
      tabId: slot.tabId,
      provider: slot.provider,
    })),
  };
}
