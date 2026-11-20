(() => {
  if (window.__AXAI_INJECTED__) return;
  window.__AXAI_INJECTED__ = true;

  const log = (...a) => console.log('[AXAI]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let extDead = false;
  const timers = [];
  const observers = [];

  function extAlive() {
    if (extDead) return false;
    let ok = false;
    try { ok = !!chrome.runtime?.id; } catch (_) {}
    if (!ok) shutdown();
    return ok;
  }

  function shutdown() {
    if (extDead) return;
    extDead = true;
    timers.forEach(clearInterval);
    observers.forEach(o => o.disconnect());
    pendingEntries.length = 0;
    document.getElementById(TOOLBAR_ID)?.remove();
    document.getElementById(STATUS_ID)?.remove();
    document.querySelectorAll('article[data-axai-checking]').forEach(a => delete a.dataset.axaiChecking);
    const tip = document.createElement('div');
    tip.textContent = 'Anti-XAI 扩展已更新，请刷新页面后继续使用';
    tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#0f1419;color:#fff;padding:8px 14px;border-radius:999px;font:600 13px -apple-system,system-ui,sans-serif;';
    document.body?.appendChild(tip);
    setTimeout(() => tip.remove(), 6000);
  }

  const send = msg => new Promise(resolve => {
    if (!extAlive()) return resolve(null);
    try {
      chrome.runtime.sendMessage(msg, resolve);
    } catch (_) {
      extAlive();
      resolve(null);
    }
  });

  const isStatus = () => /^\/[^/]+\/status\/\d+/.test(location.pathname);
  const getOpHandle = () => location.pathname.match(/^\/([^/]+)\/status\/\d+/)?.[1]?.toLowerCase() || null;

  function getTweetPermalink(article) {
    const timeAnchor = article.querySelector('a[href*="/status/"] time')?.closest('a');
    const candidates = timeAnchor ? [timeAnchor, ...article.querySelectorAll('a[href*="/status/"]')] : article.querySelectorAll('a[href*="/status/"]');
    for (const a of candidates) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/[^/]+\/status\/\d+(?:\/.*)?$/);
      if (m) {
        const base = m[0].replace(/\/(photo|video|analytics).*$/, '');
        return 'https://x.com' + base;
      }
    }
    return null;
  }

  function statusIdOf(article) {
    return getTweetPermalink(article)?.match(/\/status\/(\d+)/)?.[1] || null;
  }

  function isCurrentStatusArticle(article) {
    const cur = location.pathname.match(/\/status\/(\d+)/);
    if (!cur) return false;
    if (statusIdOf(article) === cur[1]) return true;
    return !!article.querySelector(`a[href*="/status/${cur[1]}"]`);
  }

  function findOpIndex(articles) {
    for (let i = 0; i < articles.length; i++) {
      if (isCurrentStatusArticle(articles[i])) return i;
    }
    return -1;
  }

  function readText(el) {
    if (!el) return '';
    let out = '';
    const walk = node => {
      for (const c of node.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) out += c.nodeValue;
        else if (c.nodeType === Node.ELEMENT_NODE) {
          if (c.tagName === 'IMG') out += c.getAttribute('alt') || '';
          else walk(c);
        }
      }
    };
    walk(el);
    return out.trim();
  }

  function extractUser(article) {
    const nameBlock = article.querySelector('div[data-testid="User-Name"]');
    if (!nameBlock) return null;
    let handle = null;
    let displayName = '';
    const anchors = nameBlock.querySelectorAll('a[href^="/"]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (/^\/[^/]+$/.test(href)) {
        handle = href.slice(1);
        break;
      }
    }
    if (!handle) return null;
    const nameSpan = nameBlock.querySelector('span');
    if (nameSpan) displayName = readText(nameSpan);
    const blueVerified = !!nameBlock.querySelector('svg[data-testid="icon-verified"]');
    return {
      handle,
      name: displayName,
      blue_verified: blueVerified,
      profileUrl: 'https://x.com/' + handle
    };
  }

  function getTweetText(article) {
    return readText(article.querySelector('div[data-testid="tweetText"]'));
  }

  function hasMedia(article) {
    return !!article.querySelector('div[data-testid="tweetPhoto"], div[data-testid="videoPlayer"], div[data-testid="videoComponent"]');
  }

  function getSelfHandle() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = a?.getAttribute('href') || '';
    return href.startsWith('/') ? href.slice(1).toLowerCase() : null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  async function waitFor(selector, timeoutMs = 4000, root = document) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(150);
    }
    return null;
  }

  function findMenuItemByText(menu, matchers) {
    const items = menu.querySelectorAll('div[role="menuitem"], [role="menuitem"]');
    for (const it of items) {
      const txt = (it.textContent || '').trim();
      for (const m of matchers) {
        if (m instanceof RegExp ? m.test(txt) : txt.includes(m)) return it;
      }
    }
    return null;
  }

  const blockedHandles = new Set();
  const blockingHandles = new Set();
  const isBlocked = handle => blockedHandles.has((handle || '').toLowerCase());

  async function blockAuthorFromArticle(article) {
    if (!article || !document.body.contains(article) || !isVisible(article)) {
      return { ok: false, reason: 'article_not_visible' };
    }
    article.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(300);
    const caret = article.querySelector('button[data-testid="caret"]');
    if (!caret) return { ok: false, reason: 'no_caret' };
    caret.click();
    await sleep(400);

    const menu = await waitFor('div[role="menu"]', 3000);
    if (!menu) return { ok: false, reason: 'no_menu' };

    const blockItem = findMenuItemByText(menu, [
      /^Block\s+@/i,
      /Block\s+@/i,
      '屏蔽 @',
      '封鎖 @',
      'ブロック',
      'Bloquear'
    ]);
    if (!blockItem) {
      document.body.click();
      return { ok: false, reason: 'no_block_menu_item' };
    }
    blockItem.click();
    await sleep(400);

    const confirmBtn = await waitFor('button[data-testid="confirmationSheetConfirm"]', 3500);
    if (!confirmBtn) return { ok: false, reason: 'no_confirm' };
    confirmBtn.click();
    await sleep(600);
    return { ok: true, via: 'ui' };
  }

  async function blockUser(user, article) {
    if (!extAlive()) return { ok: false, reason: 'extension_reloaded' };
    const key = user.handle.toLowerCase();
    if (blockedHandles.has(key)) return { ok: true, already: true };
    if (blockingHandles.has(key)) return { ok: false, reason: 'in_progress' };
    blockingHandles.add(key);
    try {
      const result = await blockAuthorFromArticle(article);
      if (result.ok) blockedHandles.add(key);
      return result;
    } finally {
      blockingHandles.delete(key);
    }
  }

  const STYLE_ID = 'axai-styles';
  const TOOLBAR_ID = 'axai-toolbar';
  const STATUS_ID = 'axai-status';
  const RESCAN_BTN_ID = 'axai-rescan-btn';
  const CONFIG_BTN_ID = 'axai-config-btn';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      article[data-axai-checking="1"] {
        outline: 1px dashed rgba(148, 163, 184, 0.45) !important;
        outline-offset: -2px !important;
      }
      article[data-axai-high="1"] {
        background: rgba(148, 163, 184, 0.08) !important;
        transition: background 0.2s ease !important;
      }
      article[data-axai-high="1"] > *:not(.axai-badge-bar) {
        opacity: 0.45 !important;
        filter: grayscale(65%) !important;
        transition: opacity 0.2s ease, filter 0.2s ease !important;
      }
      article[data-axai-high="1"]:hover > *:not(.axai-badge-bar) {
        opacity: 1 !important;
        filter: none !important;
      }
      .axai-badge-bar {
        position: absolute !important;
        top: 6px !important;
        right: 58px !important;
        z-index: 20 !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif !important;
        pointer-events: auto !important;
      }
      .axai-pill {
        display: inline-flex !important;
        align-items: center !important;
        gap: 3px !important;
        padding: 1px 7px !important;
        border-radius: 999px !important;
        border: 1px solid transparent !important;
        font-size: 11px !important;
        font-weight: 500 !important;
        line-height: 18px !important;
        letter-spacing: 0.1px !important;
        user-select: none !important;
        white-space: nowrap !important;
      }
      .axai-pill.checking {
        background: rgba(100, 116, 139, 0.08) !important;
        border-color: rgba(100, 116, 139, 0.18) !important;
        color: #64748b !important;
      }
      .axai-pill.high {
        background: rgba(225, 29, 72, 0.08) !important;
        border-color: rgba(225, 29, 72, 0.22) !important;
        color: #b94a63 !important;
      }
      .axai-pill.mid {
        background: rgba(217, 119, 6, 0.08) !important;
        border-color: rgba(217, 119, 6, 0.22) !important;
        color: #a16207 !important;
      }
      .axai-pill.low {
        background: rgba(100, 116, 139, 0.07) !important;
        border-color: rgba(100, 116, 139, 0.16) !important;
        color: #64748b !important;
      }
      .axai-pill.err {
        background: rgba(100, 116, 139, 0.07) !important;
        border-color: rgba(100, 116, 139, 0.16) !important;
        color: #94a3b8 !important;
      }
      .axai-block-btn {
        display: inline-flex !important;
        align-items: center !important;
        padding: 1px 7px !important;
        border-radius: 999px !important;
        border: 1px solid rgba(100, 116, 139, 0.18) !important;
        background: rgba(100, 116, 139, 0.06) !important;
        color: #64748b !important;
        font-size: 11px !important;
        font-weight: 500 !important;
        line-height: 18px !important;
        cursor: pointer !important;
        user-select: none !important;
        white-space: nowrap !important;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease !important;
      }
      .axai-block-btn:hover:not(:disabled) {
        background: rgba(225, 29, 72, 0.12) !important;
        border-color: rgba(225, 29, 72, 0.32) !important;
        color: #be123c !important;
      }
      .axai-block-btn:disabled {
        opacity: 0.6 !important;
        cursor: default !important;
      }
      .axai-block-btn.blocked {
        background: rgba(100, 116, 139, 0.05) !important;
        border-color: rgba(100, 116, 139, 0.14) !important;
        color: #94a3b8 !important;
      }
      #${TOOLBAR_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-end;
      }
      #${TOOLBAR_ID} button {
        padding: 10px 15px;
        border-radius: 999px;
        border: none;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
        transition: transform 0.12s ease, opacity 0.12s ease;
      }
      #${TOOLBAR_ID} button:hover:not(:disabled) { transform: translateY(-1px); }
      #${TOOLBAR_ID} button:disabled { opacity: 0.55; cursor: default; transform: none; }
      #${RESCAN_BTN_ID} {
        background: linear-gradient(135deg, #1d9bf0 0%, #1a8cd8 100%);
      }
      #${CONFIG_BTN_ID} {
        background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      }
      #${STATUS_ID} {
        position: fixed;
        left: 50%;
        bottom: 20px;
        transform: translateX(-50%);
        z-index: 2147483647;
        padding: 7px 14px;
        border-radius: 999px;
        background: rgba(15, 20, 25, 0.92);
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
        border: 1px solid rgba(29, 155, 240, 0.7);
        pointer-events: none;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  let config = null;
  let allowSet = new Set();
  const isAllowed = handle => allowSet.has((handle || '').toLowerCase());

  const resultBySid = new Map();
  const pendingEntries = [];
  const inflightSids = new Set();
  let judgeWorkers = 0;
  const JUDGE_CONCURRENCY = 2;
  const THREAD_BATCH = 12;

  const contextIdsByPath = new Map();
  const postTextByPath = new Map();

  function rememberContextIds(all) {
    const opIndex = findOpIndex(all);
    if (opIndex < 0) return;
    let ids = contextIdsByPath.get(location.pathname);
    if (!ids) contextIdsByPath.set(location.pathname, (ids = new Set()));
    for (let i = 0; i <= opIndex; i++) {
      const id = statusIdOf(all[i]);
      if (id) ids.add(id);
    }
  }

  function cachedPostText() {
    if (!isStatus()) return '';
    const all = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const op = all[findOpIndex(all)];
    if (op) postTextByPath.set(location.pathname, getTweetText(op));
    return postTextByPath.get(location.pathname) || '';
  }

  function articlesInScope() {
    const all = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (config?.browseScope === 'all') return all;
    if (!isStatus()) return [];
    rememberContextIds(all);
    const ids = contextIdsByPath.get(location.pathname);
    if (!ids) return [];
    return all.filter(a => {
      const id = statusIdOf(a);
      return id && !ids.has(id);
    });
  }

  function clearArticleBadge(article) {
    delete article.dataset.axaiChecking;
    delete article.dataset.axaiHigh;
    article.querySelector(':scope > .axai-badge-bar')?.remove();
    delete article.dataset.axaiSid;
  }

  function renderChecking(article, sid) {
    ensureStyles();
    article.style.setProperty('position', 'relative', 'important');
    article.dataset.axaiSid = sid;
    article.dataset.axaiChecking = '1';
    delete article.dataset.axaiHigh;
    article.querySelector(':scope > .axai-badge-bar')?.remove();

    const bar = document.createElement('div');
    bar.className = 'axai-badge-bar';
    const pill = document.createElement('span');
    pill.className = 'axai-pill checking';
    pill.textContent = '探测中…';
    bar.appendChild(pill);
    article.appendChild(bar);
  }

  function renderResult(article, sid, res) {
    ensureStyles();
    article.style.setProperty('position', 'relative', 'important');
    article.dataset.axaiSid = sid;
    delete article.dataset.axaiChecking;
    article.querySelector(':scope > .axai-badge-bar')?.remove();

    const threshold = config?.aiThreshold ?? 0.6;
    const midThreshold = Math.max(0.35, threshold * 0.65);
    const score = typeof res.score === 'number' ? res.score : null;
    const isHigh = score != null && score >= threshold;
    if (isHigh) article.dataset.axaiHigh = '1';
    else delete article.dataset.axaiHigh;

    const bar = document.createElement('div');
    bar.className = 'axai-badge-bar';
    const stop = e => { e.stopPropagation(); e.preventDefault(); };
    bar.addEventListener('mousedown', e => e.stopPropagation());
    bar.addEventListener('pointerdown', e => e.stopPropagation());

    const pill = document.createElement('span');
    if (score == null) {
      const blockedByPolicy = /Input blocked|Prohibited Use|sensitive/i.test(res.error || '');
      pill.className = 'axai-pill err';
      pill.textContent = blockedByPolicy ? '内容受限' : '探测失败';
      pill.title = res.error || '决策接口返回异常';
    } else {
      const pct = Math.round(score * 100);
      pill.className = `axai-pill ${isHigh ? 'high' : score >= midThreshold ? 'mid' : 'low'}`;
      pill.textContent = `AI ${pct}%`;
      pill.title = [
        `AI Slop 概率：${pct}%（阈值 ${Math.round(threshold * 100)}%）`,
        res.category ? `分类：${res.category}` : '',
        res.reason || '',
        res.mock ? '当前为 Mock 模拟结果' : ''
      ].filter(Boolean).join('\n');
    }
    bar.appendChild(pill);

    if (res.user?.handle) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'axai-block-btn';
      btn.dataset.handle = res.user.handle.toLowerCase();
      if (isBlocked(res.user.handle)) {
        btn.classList.add('blocked');
        btn.disabled = true;
        btn.textContent = '已屏蔽';
      } else {
        btn.textContent = '屏蔽';
        btn.title = `通过页面菜单屏蔽 @${res.user.handle}`;
        btn.addEventListener('click', async e => {
          stop(e);
          if (btn.disabled) return;
          btn.disabled = true;
          btn.textContent = '屏蔽中…';
          const r = await blockUser(res.user, article);
          if (r.ok) {
            markHandleBlockedInDom(res.user.handle);
            send({
              type: 'BLOCKED_USER',
              user: { ...res.user, text: res.text, score: res.score, category: res.category, reason: res.reason, mock: res.mock },
              replyUrl: res.replyUrl,
              postUrl: res.postUrl,
              postText: res.postText
            });
          } else {
            btn.disabled = false;
            btn.textContent = '重试屏蔽';
            btn.title = `屏蔽失败：${r.reason || '未知错误'}`;
          }
        });
      }
      bar.appendChild(btn);
    }

    article.appendChild(bar);
  }

  function markHandleBlockedInDom(handle) {
    const lower = (handle || '').toLowerCase();
    document.querySelectorAll(`.axai-block-btn[data-handle="${CSS.escape(lower)}"]`).forEach(btn => {
      btn.classList.add('blocked');
      btn.disabled = true;
      btn.textContent = '已屏蔽';
    });
  }

  function ensureToolbar() {
    const show = isStatus() || config?.browseScope === 'all';
    if (!show) {
      document.getElementById(TOOLBAR_ID)?.remove();
      return;
    }
    ensureStyles();
    let bar = document.getElementById(TOOLBAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = TOOLBAR_ID;
      (document.body || document.documentElement).appendChild(bar);
    }
    updateToolbar();
  }

  function updateToolbar() {
    const bar = document.getElementById(TOOLBAR_ID);
    if (!bar) return;

    if (!config?.hasJevConfig) {
      bar.innerHTML = '';
      const cfgBtn = document.createElement('button');
      cfgBtn.id = CONFIG_BTN_ID;
      cfgBtn.type = 'button';
      cfgBtn.textContent = '⚠️ 请先配置决策接口';
      cfgBtn.title = 'Anti-XAI 需要配置 Jev 或 Gemini API Key 才能开始探测';
      cfgBtn.addEventListener('click', () => send({ type: 'OPEN_OPTIONS' }));
      bar.appendChild(cfgBtn);
      return;
    }

    if (!document.getElementById(RESCAN_BTN_ID)) {
      bar.innerHTML = '';
      const rescanBtn = document.createElement('button');
      rescanBtn.id = RESCAN_BTN_ID;
      rescanBtn.type = 'button';
      rescanBtn.textContent = '🔍 重新探测';
      rescanBtn.addEventListener('click', onRescanClick);
      bar.appendChild(rescanBtn);
    }
  }

  function onRescanClick() {
    for (const article of articlesInScope()) {
      const sid = statusIdOf(article);
      if (sid) resultBySid.delete(sid);
      clearArticleBadge(article);
    }
    scanPage();
  }

  function updateStatusBar() {
    let el = document.getElementById(STATUS_ID);
    const busy = judgeWorkers > 0 || pendingEntries.length > 0;
    if (!busy) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = STATUS_ID;
      (document.body || document.documentElement).appendChild(el);
    }
    const prov = config?.provider === 'gemini' ? 'Gemini' : 'Jev';
    el.textContent = `🤖 ${prov} AI Slop 探测中 · 排队 ${pendingEntries.length}`;
  }

  const logBuffer = [];
  let logFlushTimer = null;
  function pushLog(rec) {
    logBuffer.push(rec);
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => {
        logFlushTimer = null;
        if (logBuffer.length) send({ type: 'DETECT_LOG', records: logBuffer.splice(0) });
      }, 200);
    }
  }

  function sweepStaleBadges() {
    document.querySelectorAll('article[data-axai-sid]').forEach(article => {
      const sid = statusIdOf(article);
      if (!sid || article.dataset.axaiSid !== sid) clearArticleBadge(article);
    });
  }

  function scanPage() {
    if (!extAlive()) return;
    sweepStaleBadges();
    ensureToolbar();
    if (!config?.detectEnabled || !config?.hasJevConfig) return;

    const self = getSelfHandle();
    const opHandle = isStatus() ? getOpHandle() : null;
    for (const article of articlesInScope()) {
      const sid = statusIdOf(article);
      if (!sid) continue;
      if (article.dataset.axaiSid === sid) continue;

      const user = extractUser(article);
      if (!user) continue;
      const lower = user.handle.toLowerCase();
      if ((self && lower === self) || (opHandle && lower === opHandle)) {
        article.dataset.axaiSid = sid;
        continue;
      }
      if (isAllowed(user.handle)) {
        article.dataset.axaiSid = sid;
        continue;
      }

      if (resultBySid.has(sid)) {
        renderResult(article, sid, resultBySid.get(sid));
        continue;
      }
      if (inflightSids.has(sid)) {
        renderChecking(article, sid);
        continue;
      }

      inflightSids.add(sid);
      renderChecking(article, sid);
      pendingEntries.push({
        sid,
        article,
        user,
        text: getTweetText(article),
        hasMedia: hasMedia(article),
        replyUrl: getTweetPermalink(article)
      });
    }
    updateToolbar();
    pumpJudge();
  }

  function pumpJudge() {
    while (judgeWorkers < JUDGE_CONCURRENCY && pendingEntries.length) {
      judgeWorkers++;
      judgeWorker().finally(() => {
        judgeWorkers--;
        updateStatusBar();
        pumpJudge();
      });
    }
    updateStatusBar();
  }

  async function judgeWorker() {
    const threadMode = config?.jevMode !== 'single';
    while (pendingEntries.length && !extDead) {
      if (threadMode && pendingEntries.length < 4) await sleep(250);
      const max = threadMode ? THREAD_BATCH : 1;
      const activeBatch = pendingEntries.splice(0, max);
      if (!activeBatch.length) continue;
      updateStatusBar();

      const postText = cachedPostText();
      const postUrl = location.href;

      const items = activeBatch.map((e, i) => ({
        id: String(i),
        handle: e.user.handle,
        name: e.user.name,
        blue_verified: !!e.user.blue_verified,
        text: e.text,
        hasMedia: e.hasMedia,
        postText: postText.slice(0, 600)
      }));

      let res = null;
      if (threadMode) {
        res = await send({
          type: 'JEV_CLASSIFY_THREAD',
          items,
          postText: postText.slice(0, 1000)
        });
      } else {
        res = await send({ type: 'JEV_CLASSIFY', items });
      }

      const threshold = config?.aiThreshold ?? 0.6;
      activeBatch.forEach((e, i) => {
        inflightSids.delete(e.sid);
        const r = res?.ok ? res.results?.[String(i)] : { error: res?.reason || 'jev_request_failed' };
        const score = typeof r?.score === 'number' ? r.score : null;
        const flagged = score != null && score >= threshold;
        const stored = {
          score,
          category: r?.category || null,
          reason: r?.reason || null,
          mock: !!r?.mock,
          error: r?.error || null,
          user: e.user,
          text: e.text,
          replyUrl: e.replyUrl,
          postUrl,
          postText: postText.replace(/\s+/g, ' ').trim().slice(0, 100)
        };
        resultBySid.set(e.sid, stored);
        if (resultBySid.size > 4000) resultBySid.delete(resultBySid.keys().next().value);

        if (e.article.isConnected && statusIdOf(e.article) === e.sid) {
          renderResult(e.article, e.sid, stored);
        }

        pushLog({
          handle: e.user.handle,
          name: e.user.name,
          profileUrl: e.user.profileUrl,
          statusUrl: e.replyUrl,
          text: (e.text || '').slice(0, 280),
          postUrl,
          postText: stored.postText,
          flagged,
          detector: r?.mock ? 'jev-mock' : (config?.provider || 'jev'),
          score,
          category: r?.category || null,
          reason: r?.reason || null,
          mock: !!r?.mock,
          error: r?.error || null,
          status: isBlocked(e.user.handle) ? 'blocked' : (flagged ? 'detected' : 'normal'),
          checkedAt: new Date().toISOString()
        });
      });

      updateToolbar();
    }
  }

  async function refreshConfig() {
    config = await send({ type: 'GET_CONFIG' });
    allowSet = new Set((config?.allowHandles || []).map(h => h.toLowerCase()));
    ensureToolbar();
    for (const article of articlesInScope()) {
      const sid = statusIdOf(article);
      if (sid && resultBySid.has(sid)) renderResult(article, sid, resultBySid.get(sid));
    }
    updateToolbar();
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanPage();
    }, 250);
  }

  async function start() {
    ensureStyles();
    await refreshConfig();
    const res = await send({ type: 'GET_BLOCKED_HANDLES' });
    for (const h of res?.handles || []) blockedHandles.add(h.toLowerCase());

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local') return;
      await refreshConfig();
      scheduleScan();
    });

    const mo = new MutationObserver(scheduleScan);
    mo.observe(document.body, { childList: true, subtree: true });
    observers.push(mo);

    let lastPath = location.pathname;
    timers.push(setInterval(() => {
      if (!extAlive()) return;
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        ensureToolbar();
        scheduleScan();
      } else if ((isStatus() || config?.browseScope === 'all') && !document.getElementById(TOOLBAR_ID)) {
        ensureToolbar();
      }
    }, 800));

    scheduleScan();
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
