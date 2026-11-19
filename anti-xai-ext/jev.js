const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_DEFAULT_MODEL = 'jev-1.13.0';
const GEMINI_DECISION_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const GEMINI_DECISION_MODEL = 'gemini-decision-1';

const JEV_STATE_MAX_CHARS = 4000;
const JEV_THREAD_STATE_MAX = 24000;
const JEV_THREAD_BATCH = 12;
const JEV_CACHE_MAX = 2000;

const JEV_AI_CATEGORY_REASON = {
  human: '自然人类互动特征',
  likely_ai: '疑似 AI 润色或半自动回复',
  ai_slop: '典型 AI Slop / 模板化养号回复特征'
};

const FALLBACK_PROMPT_CONFIG = {
  schema_version: 1,
  threshold: 0.6,
  use_thread_context: true,
  input_fields: ['post_text', 'author.name', 'author.handle', 'author.blue_verified', 'reply_text', 'has_media'],
  instructions: '这条 X (Twitter) 回复是不是由 AI 自动生成或 AI 辅助批量刷评的「AI Slop」？',
  categories: {
    human: '正常人类回复',
    likely_ai: '疑似 AI 润色回复',
    ai_slop: '典型 AI Slop 刷评'
  }
};

const jevCache = new Map();

function activePromptConfig(config) {
  return config?.promptConfig || FALLBACK_PROMPT_CONFIG;
}

function jevCacheKey(item, config) {
  const pc = activePromptConfig(config);
  return [
    config?.provider || 'jev',
    config?.jevModel || '',
    (pc.instructions || '').slice(0, 60),
    item.handle,
    item.name,
    item.blue_verified ? '1' : '0',
    item.text,
    (item.postText || '').slice(0, 120)
  ].join('\u0001');
}

function jevCachePut(key, value) {
  jevCache.set(key, value);
  if (jevCache.size > JEV_CACHE_MAX) {
    jevCache.delete(jevCache.keys().next().value);
  }
}

function buildJevState(item, includePost = true) {
  const lines = [
    `回复作者显示名: ${item.name || '(空)'}`,
    `回复作者 @handle: @${item.handle || ''}`,
    `蓝V认证: ${item.blue_verified ? '是' : '否'}`,
    `回复内容: ${item.text || '(无文字，可能只有图片/视频/表情)'}`,
    `附带媒体: ${item.hasMedia ? '是' : '否'}`
  ];
  if (includePost && item.postText) {
    lines.push(`被回复的原帖内容: ${String(item.postText).slice(0, 600)}`);
  }
  return lines.join('\n').slice(0, JEV_STATE_MAX_CHARS);
}

function buildThreadState(items, postText) {
  const head = `原帖内容: ${(postText || '(未知)').slice(0, 1000)}\n\n待探测的回复:\n`;
  const blocks = items.map((it, i) => [
    `[r${i + 1}] 显示名: ${it.name || '(空)'} | @${it.handle || ''} | 蓝V: ${it.blue_verified ? '是' : '否'}`,
    `    回复: ${it.text || '(无文字，可能只有图片/视频)'}`,
    `    附带媒体: ${it.hasMedia ? '是' : '否'}`
  ].join('\n'));
  return (head + blocks.join('\n')).slice(0, JEV_THREAD_STATE_MAX);
}

function singleQuestions(promptCfg) {
  return {
    ai_slop: { type: 'noul', instructions: promptCfg.instructions },
    category: { type: 'choice', instructions: '这条回复最符合哪一类？', criteria: promptCfg.categories }
  };
}

function threadQuestionsFor(i, promptCfg) {
  return {
    [`r${i}`]: { type: 'noul', instructions: `针对回复 [r${i}]：\n${promptCfg.instructions}` },
    [`r${i}_cat`]: { type: 'choice', instructions: `回复 [r${i}] 最符合哪一类？`, criteria: promptCfg.categories }
  };
}

function readNoul(a) {
  if (typeof a === 'number') return a;
  if (a && typeof a.noul === 'number') return a.noul;
  if (a && typeof a.probability === 'number') return a.probability;
  return null;
}

function readChoice(a) {
  if (!a) return null;
  if (typeof a === 'string') return a;
  return a.choice || null;
}

function isInputBlockedError(err) {
  return /http_400|Input blocked|sensitive words|Prohibited Use/i.test(String(err?.message || err || ''));
}

async function readApiError(res) {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    if (j.error?.message) return j.error.message;
    if (Array.isArray(j.detail)) {
      return j.detail.map(d => `${(d.loc || []).filter(x => x !== 'body').join('.')}: ${d.msg}`).join('; ');
    }
    if (j.detail?.message) return j.detail.message;
    if (j.error) return typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
  } catch (_) {}
  return raw.slice(0, 200);
}

const AUTH_PAUSE_MS = 5 * 60 * 1000;
let apiPause = null;

function jevResetPause() {
  apiPause = null;
}

async function decisionPost(textInput, questions, config, timeoutMs = 25000) {
  if (apiPause && Date.now() < apiPause.until) throw new Error(`api_paused ${apiPause.reason}`);

  const isGemini = config.provider === 'gemini';
  const endpoint = isGemini
    ? (config.jevEndpoint || GEMINI_DECISION_ENDPOINT)
    : (config.jevEndpoint || JEV_DEFAULT_ENDPOINT);
  const model = isGemini
    ? (config.jevModel || GEMINI_DECISION_MODEL)
    : (config.jevModel || JEV_DEFAULT_MODEL);

  const headers = { 'Content-Type': 'application/json' };
  if (isGemini) headers['x-goog-api-key'] = config.jevApiKey;
  else headers.Authorization = `Bearer ${config.jevApiKey}`;

  const payload = isGemini
    ? { model, input: textInput, questions }
    : { model, state: textInput, questions };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        const reason = `http_${res.status} ${await readApiError(res)}`;
        if (res.status === 401 || res.status === 403) {
          apiPause = { until: Date.now() + AUTH_PAUSE_MS, reason: `API Key 无效或无权限（${res.status}）` };
        }
        throw new Error(reason);
      }
      apiPause = null;
      return { json: await res.json(), model };
    }
    throw new Error('api_retry_exhausted');
  } finally {
    clearTimeout(timer);
  }
}

async function jevDecideOne(item, config) {
  const key = jevCacheKey(item, config);
  if (jevCache.has(key)) return { ...jevCache.get(key), cached: true };

  const promptCfg = activePromptConfig(config);
  const questions = singleQuestions(promptCfg);
  let resp;
  try {
    resp = await decisionPost(buildJevState(item, true), questions, config);
  } catch (e) {
    if (isInputBlockedError(e) && item.postText) {
      resp = await decisionPost(buildJevState(item, false), questions, config);
    } else {
      throw e;
    }
  }
  const { json, model } = resp;
  const answers = json?.answers || json?.data?.answers || {};
  const score = readNoul(answers.ai_slop);
  if (score == null) throw new Error('bad_decision_response');
  const category = readChoice(answers.category) || (score >= 0.6 ? 'ai_slop' : score >= 0.4 ? 'likely_ai' : 'human');
  const result = {
    score,
    confidence: answers.ai_slop?.confidence ?? null,
    signals: { ai_slop: score },
    category,
    reason: JEV_AI_CATEGORY_REASON[category] || '',
    mode: 'single',
    provider: config.provider || 'jev',
    model: json?.model || model,
    mock: false
  };
  jevCachePut(key, result);
  return result;
}

async function jevClassifyBatch(items, config, concurrency = 4) {
  const out = {};
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        out[item.id] = await jevDecideOne(item, config);
      } catch (e) {
        out[item.id] = { error: String(e?.message || e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

async function jevClassifyThread(items, postText, config) {
  const out = {};
  const promptCfg = activePromptConfig(config);
  for (let start = 0; start < items.length; start += JEV_THREAD_BATCH) {
    const chunk = items.slice(start, start + JEV_THREAD_BATCH);
    const questions = {};
    chunk.forEach((_, i) => {
      Object.assign(questions, threadQuestionsFor(i + 1, promptCfg));
    });
    try {
      const { json, model } = await decisionPost(buildThreadState(chunk, postText), questions, config, 25000);
      const answers = json?.answers || json?.data?.answers || {};
      chunk.forEach((it, i) => {
        const k = `r${i + 1}`;
        const v = readNoul(answers[k]);
        if (v == null) {
          out[it.id] = { error: 'bad_decision_response' };
          return;
        }
        const category = readChoice(answers[`${k}_cat`]) || (v >= 0.6 ? 'ai_slop' : v >= 0.4 ? 'likely_ai' : 'human');
        out[it.id] = {
          score: v,
          confidence: answers[k]?.confidence ?? null,
          signals: { ai_slop: v },
          category,
          reason: JEV_AI_CATEGORY_REASON[category] || '',
          mode: 'thread',
          provider: config.provider || 'jev',
          model: json?.model || model,
          mock: false
        };
      });
    } catch (e) {
      if (isInputBlockedError(e) && chunk.length > 1) {
        const fallback = await jevClassifyBatch(chunk.map(it => ({ ...it, postText })), config, 4);
        Object.assign(out, fallback);
      } else if (isInputBlockedError(e) && chunk.length === 1) {
        try {
          out[chunk[0].id] = await jevDecideOne({ ...chunk[0], postText }, config);
        } catch (e2) {
          out[chunk[0].id] = { error: String(e2?.message || e2) };
        }
      } else {
        chunk.forEach(it => { out[it.id] = { error: String(e?.message || e) }; });
      }
    }
  }
  return out;
}

async function jevPing(config) {
  const t0 = Date.now();
  jevResetPause();
  const out = await jevClassifyThread(
    [{ id: 'p', handle: 'test_user', name: 'Alex | AI', blue_verified: true, text: 'Great insight! This really highlights how rapidly the landscape is evolving. What do you think?', hasMedia: false }],
    'AI tools are changing software engineering.',
    config
  );
  if (out.p?.error) {
    return {
      ok: false,
      reason: out.p.error,
      provider: config.provider || 'jev',
      endpoint: config.jevEndpoint,
      at: new Date().toISOString()
    };
  }
  return {
    ok: true,
    ms: Date.now() - t0,
    provider: config.provider || 'jev',
    model: out.p?.model || config.jevModel || (config.provider === 'gemini' ? GEMINI_DECISION_MODEL : JEV_DEFAULT_MODEL),
    score: out.p?.score ?? null,
    endpoint: config.jevEndpoint,
    at: new Date().toISOString()
  };
}
