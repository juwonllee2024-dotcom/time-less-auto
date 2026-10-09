export const AI_TAB_CATALOG = Object.freeze({
  chatgpt: Object.freeze({ label: 'ChatGPT', url: 'https://chatgpt.com/' }),
  claude: Object.freeze({ label: 'Claude', url: 'https://claude.ai/new' }),
  gemini: Object.freeze({ label: 'Gemini', url: 'https://gemini.google.com/app' }),
  copilot: Object.freeze({ label: 'Copilot', url: 'https://copilot.microsoft.com/' }),
});

export function aiTabTarget(provider) {
  const key = String(provider || '').trim().toLowerCase();
  const target = AI_TAB_CATALOG[key];
  return target ? { provider: key, ...target } : null;
}

export function normalizeRequestedProviders(values = []) {
  const source = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const normalized = [];
  for (const value of source) {
    const key = String(value || '').trim().toLowerCase();
    if (!AI_TAB_CATALOG[key] || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

export function aiTabTargets(values = []) {
  return normalizeRequestedProviders(values).map((provider) => aiTabTarget(provider));
}
