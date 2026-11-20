importScripts('jev.js', 'store.js');

const AXAI_BUILD = '0.2.0';

const DEFAULTS = {
  detectEnabled: true,
  provider: 'jev',
  jevService: 'official',
  jevCustomUrl: '',
  jevApiKey: '',
  jevModel: '',
  jevMode: 'thread',
  aiThreshold: null,
  browseScope: 'replies',
  allowHandles: [],
  promptConfig: null
};

let bundledPromptPromise = null;
function loadBundledPromptConfig() {
  if (!bundledPromptPromise) {
    bundledPromptPromise = fetch(chrome.runtime.getURL('prompt_config.json'))
      .then(r => r.json())
      .catch(() => FALLBACK_PROMPT_CONFIG);
  }
  return bundledPromptPromise;
}

function normalizePromptConfig(saved, bundled) {
  const base = bundled || FALLBACK_PROMPT_CONFIG;
  const src = saved && typeof saved === 'object' ? saved : {};
  return {
    schema_version: 1,
    threshold: typeof src.threshold === 'number' && Number.isFinite(src.threshold)
      ? Math.min(0.95, Math.max(0.05, src.threshold))
      : (base.threshold ?? 0.6),
    use_thread_context: typeof src.use_thread_context === 'boolean'
      ? src.use_thread_context
      : (base.use_thread_context !== false),
    input_fields: Array.isArray(base.input_fields) ? base.input_fields : FALLBACK_PROMPT_CONFIG.input_fields,
    instructions: typeof src.instructions === 'string' && src.instructions.trim()
      ? src.instructions.trim()
      : base.instructions,
    categories: src.categories && typeof src.categories === 'object'
      ? {
          human: src.categories.human || base.categories.human,
          likely_ai: src.categories.likely_ai || base.categories.likely_ai,
          ai_slop: src.categories.ai_slop || base.categories.ai_slop
        }
      : base.categories
  };
}

function deriveConfig(cfg, bundledPrompt) {
  const provider = cfg.provider === 'gemini' ? 'gemini' : 'jev';
  cfg.provider = provider;
  const endpoint = provider === 'gemini'
    ? GEMINI_DECISION_ENDPOINT
    : (cfg.jevService === 'custom' ? (cfg.jevCustomUrl || '').trim() : JEV_DEFAULT_ENDPOINT);
  const apiKey = (cfg.jevApiKey || '').trim();
  cfg.jevEndpoint = endpoint;
  cfg.effectiveModel = (cfg.jevModel || '').trim() || (provider === 'gemini' ? GEMINI_DECISION_MODEL : JEV_DEFAULT_MODEL);
  cfg.hasJevKey = !!apiKey;
  cfg.hasJevConfig = !!(apiKey && endpoint);
  cfg.promptConfig = normalizePromptConfig(cfg.promptConfig, bundledPrompt);
  cfg.aiThreshold = typeof cfg.aiThreshold === 'number' && Number.isFinite(cfg.aiThreshold)
    ? Math.min(0.95, Math.max(0.05, cfg.aiThreshold))
    : cfg.promptConfig.threshold;
  cfg.promptConfig.threshold = cfg.aiThreshold;
  cfg.promptConfig.use_thread_context = cfg.jevMode !== 'single';
  return cfg;
}

function dedupeLower(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const k = (item || '').trim();
    if (!k) continue;
    const lower = k.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(k);
  }
  return out;
}

async function getConfig() {
  const [stored, bundled] = await Promise.all([
    chrome.storage.local.get(DEFAULTS),
    loadBundledPromptConfig()
  ]);
  return deriveConfig(stored, bundled);
}

const pendingAppends = [];
const pendingUpdates = [];
let writing = null;
let writeWaiters = [];

function requestWrite() {
  return new Promise(resolve => {
    writeWaiters.push(resolve);
    if (!writing) writing = runWrites();
  });
}

async function runWrites() {
  while (pendingAppends.length || pendingUpdates.length) {
    const waiters = writeWaiters.splice(0);
    const appends = pendingAppends.splice(0);
    const updates = pendingUpdates.splice(0);
    try {
      await AXAI_STORE.append(appends);
      for (const u of updates) {
        if (u.ensure) await AXAI_STORE.ensureBlocked(u.ensure);
        else await AXAI_STORE.updateStatus(u);
      }
    } catch (e) {
      console.warn('[AXAI] write records failed', e);
    }
    chrome.runtime.sendMessage({ type: 'DETECT_LOG_CHANGED' }).catch(() => {});
    waiters.forEach(fn => fn());
  }
  writing = null;
  writeWaiters.splice(0).forEach(fn => fn());
}

function appendDetectLog(records) {
  const now = new Date().toISOString();
  for (const r of [].concat(records)) pendingAppends.push({ ...r, checkedAt: r.checkedAt || now });
  return requestWrite();
}

function updateDetectLog(handle, status, reason) {
  pendingUpdates.push({ handle, status, reason, at: new Date().toISOString() });
  return requestWrite();
}

function ensureBlockedRecord(record) {
  pendingUpdates.push({ ensure: record });
  return requestWrite();
}

const THREAD_CACHE_TTL_MS = 30 * 60 * 1000;
const threadCache = new Map();
const threadInflight = new Map();

function threadKey(it, postText, config) {
  const pHead = (config?.promptConfig?.instructions || '').slice(0, 60);
  return [config?.provider || 'jev', config?.effectiveModel || '', pHead, (postText || '').slice(0, 120), it.handle, it.blue_verified ? '1' : '0', it.text].join('\u0001');
}

async function classifyThreadShared(items, postText, config) {
  const out = {};
  const todo = [];
  const waits = [];
  const now = Date.now();
  for (const it of items) {
    const k = threadKey(it, postText, config);
    const cached = threadCache.get(k);
    if (cached && now - cached.at < THREAD_CACHE_TTL_MS) {
      out[it.id] = cached.result;
    } else if (threadInflight.has(k)) {
      waits.push(threadInflight.get(k).then(r => { out[it.id] = r; }));
    } else {
      todo.push({ it, k });
    }
  }
  if (todo.length) {
    const p = jevClassifyThread(todo.map(t => t.it), postText, config);
    for (const { it, k } of todo) threadInflight.set(k, p.then(res => res[it.id]));
    const res = await p;
    for (const { it, k } of todo) {
      threadInflight.delete(k);
      out[it.id] = res[it.id];
      if (res[it.id] && !res[it.id].error) threadCache.set(k, { at: Date.now(), result: res[it.id] });
    }
    while (threadCache.size > 5000) threadCache.delete(threadCache.keys().next().value);
  }
  await Promise.all(waits);
  return out;
}

async function markFalsePositive(handle) {
  const config = await getConfig();
  const allow = dedupeLower([...(config.allowHandles || []), handle]);
  await AXAI_STORE.markFalsePositive(handle, 'normal');
  await chrome.storage.local.set({ allowHandles: allow });
  chrome.runtime.sendMessage({ type: 'DETECT_LOG_CHANGED' }).catch(() => {});
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'GET_CONFIG': {
        const cfg = await getConfig();
        delete cfg.jevApiKey;
        sendResponse(cfg);
        return;
      }
      case 'SET_CONFIG': {
        const patch = { ...(msg.config || {}) };
        if (patch.promptConfig && typeof patch.promptConfig === 'object') {
          const bundled = await loadBundledPromptConfig();
          const norm = normalizePromptConfig(patch.promptConfig, bundled);
          patch.promptConfig = norm;
          patch.aiThreshold = norm.threshold;
          patch.jevMode = norm.use_thread_context ? 'thread' : 'single';
        }
        await chrome.storage.local.set(patch);
        if (['provider', 'jevApiKey', 'jevService', 'jevCustomUrl', 'jevModel', 'promptConfig'].some(k => k in patch)) {
          jevResetPause();
          threadCache.clear();
          jevCache.clear();
        }
        sendResponse({ ok: true });
        return;
      }
      case 'RESET_PROMPT_CONFIG': {
        bundledPromptPromise = null;
        const bundled = await loadBundledPromptConfig();
        const norm = normalizePromptConfig(null, bundled);
        await chrome.storage.local.set({
          promptConfig: null,
          aiThreshold: norm.threshold,
          jevMode: norm.use_thread_context ? 'thread' : 'single'
        });
        jevResetPause();
        threadCache.clear();
        jevCache.clear();
        sendResponse({ ok: true, promptConfig: norm });
        return;
      }
      case 'OPEN_OPTIONS': {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }
      case 'JEV_CLASSIFY': {
        const config = await getConfig();
        if (!config.hasJevConfig) {
          sendResponse({ ok: false, reason: 'no_jev_config' });
          return;
        }
        const results = await jevClassifyBatch(msg.items || [], config);
        sendResponse({ ok: true, results });
        return;
      }
      case 'JEV_CLASSIFY_THREAD': {
        const config = await getConfig();
        if (!config.hasJevConfig) {
          sendResponse({ ok: false, reason: 'no_jev_config' });
          return;
        }
        const results = msg.noCache
          ? await jevClassifyThread(msg.items || [], msg.postText || '', config)
          : await classifyThreadShared(msg.items || [], msg.postText || '', config);
        sendResponse({ ok: true, results });
        return;
      }
      case 'JEV_PING': {
        const config = await getConfig();
        if (!config.hasJevConfig) {
          sendResponse({ ok: false, reason: '请先填写决策接口与 API Key' });
          return;
        }
        const result = await jevPing(config);
        await chrome.storage.local.set({ jevLastTest: result });
        sendResponse(result);
        return;
      }
      case 'DETECT_LOG': {
        await appendDetectLog(msg.records || msg.record || []);
        sendResponse({ ok: true });
        return;
      }
      case 'DETECT_UPDATE': {
        await updateDetectLog(msg.handle, msg.status, msg.reason);
        sendResponse({ ok: true });
        return;
      }
      case 'BLOCKED_USER': {
        const u = msg.user || {};
        const now = new Date().toISOString();
        await ensureBlockedRecord({
          handle: u.handle,
          name: u.name || '',
          profileUrl: u.profileUrl || `https://x.com/${u.handle}`,
          statusUrl: msg.replyUrl || null,
          text: (u.text || '').slice(0, 280),
          postUrl: msg.postUrl || '',
          postText: msg.postText || '',
          flagged: true,
          detector: u.mock ? 'jev-mock' : 'jev',
          score: typeof u.score === 'number' ? u.score : null,
          category: u.category || null,
          reason: u.reason || null,
          mock: !!u.mock,
          status: 'blocked',
          blockedAt: now,
          checkedAt: now
        });
        sendResponse({ ok: true });
        return;
      }
      case 'GET_BLOCKED_HANDLES': {
        sendResponse({ ok: true, handles: await AXAI_STORE.blockedHandles().catch(() => []) });
        return;
      }
      case 'MARK_FALSE_POSITIVE': {
        if (typeof msg.handle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(msg.handle)) {
          sendResponse({ ok: false, reason: 'bad_handle' });
          return;
        }
        sendResponse(await markFalsePositive(msg.handle));
        return;
      }
      case 'REMOVE_ALLOW': {
        const config = await getConfig();
        const allowHandles = (config.allowHandles || []).filter(h => h.toLowerCase() !== String(msg.handle).toLowerCase());
        await chrome.storage.local.set({ allowHandles });
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, reason: 'unknown_message', build: AXAI_BUILD });
    }
  })();
  return true;
});
