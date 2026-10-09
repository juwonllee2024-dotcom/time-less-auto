function integerTabId(value) {
  const tabId = Number(value);
  return Number.isInteger(tabId) ? tabId : null;
}

export function autopilotTabCapacity({ requiredRoles = 2, supportedTabs = [] } = {}) {
  const required = Math.max(2, Number.isInteger(Number(requiredRoles)) ? Number(requiredRoles) : 2);
  const ids = [...new Set((Array.isArray(supportedTabs) ? supportedTabs : [])
    .map((tab) => integerTabId(tab?.tabId))
    .filter((tabId) => tabId !== null))];
  const available = ids.length;
  const missing = Math.max(0, required - available);
  const message = missing
    ? `V2 auto run needs ${required} separate supported AI tabs for ${required} roles; ${available} open. Open ${missing} more AI tab(s), then refresh tabs.`
    : `V2 auto run has ${available} supported AI tab(s) for ${required} roles.`;
  return { ok: missing === 0, required, available, missing, tabIds: ids, message };
}
