const $ = id => document.getElementById(id);
const send = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'records') loadRecords();
}

document.querySelectorAll('.tab').forEach(b => {
  b.addEventListener('click', () => {
    location.hash = b.dataset.tab;
    activateTab(b.dataset.tab);
  });
});

function syncProviderUI() {
  const isGemini = $('provider').value === 'gemini';
  $('jevServiceWrap').style.display = isGemini ? 'none' : 'block';
  $('customUrlWrap').style.display = !isGemini && $('jevService').value === 'custom' ? 'block' : 'none';
  $('apiKeyLabel').textContent = isGemini ? 'Gemini API Key（必填）' : 'Jev API Key（必填）';
  $('jevApiKey').placeholder = isGemini ? '粘贴 Google AI Studio GEMINI_API_KEY' : '粘贴 Jev API Key';
  $('jevModel').placeholder = isGemini ? 'gemini-decision-1' : 'jev-1.13.0';
}

$('provider').addEventListener('change', syncProviderUI);
$('jevService').addEventListener('change', syncProviderUI);
$('aiThreshold').addEventListener('input', () => {
  $('thresholdVal').textContent = `${$('aiThreshold').value}%`;
});

async function loadSettings() {
  const raw = await chrome.storage.local.get(['jevApiKey']);
  const cfg = await send({ type: 'GET_CONFIG' });
  if (!cfg) return;

  $('provider').value = cfg.provider === 'gemini' ? 'gemini' : 'jev';
  $('jevService').value = cfg.jevService || 'official';
  $('jevCustomUrl').value = cfg.jevCustomUrl || '';
  $('jevApiKey').value = raw.jevApiKey || '';
  $('jevModel').value = cfg.jevModel || '';
  $('jevMode').value = cfg.jevMode || 'thread';
  syncProviderUI();

  $('detectEnabled').checked = cfg.detectEnabled !== false;
  const pct = Math.round((cfg.aiThreshold ?? 0.6) * 100);
  $('aiThreshold').value = pct;
  $('thresholdVal').textContent = `${pct}%`;
  $('browseScope').value = cfg.browseScope || 'replies';
  if ($('promptJson') && cfg.promptConfig) {
    $('promptJson').value = JSON.stringify(cfg.promptConfig, null, 2);
  }

  const pill = $('headerStatus');
  if (!cfg.hasJevConfig) {
    pill.textContent = '⚠️ 未配置决策接口';
    pill.className = 'pill warn';
  } else {
    const label = cfg.provider === 'gemini' ? 'Gemini' : 'Jev';
    pill.textContent = `${label} (${cfg.effectiveModel}) · 阈值 ${pct}%`;
    pill.className = 'pill ok';
  }

  renderAllowList(cfg.allowHandles || []);
}

function renderAllowList(handles) {
  const wrap = $('allowList');
  if (!handles.length) {
    wrap.innerHTML = '<span class="muted">暂无白名单账号</span>';
    return;
  }
  wrap.innerHTML = handles.map(h =>
    `<span class="chip">@${escapeHtml(h)} <button type="button" data-remove="${escapeHtml(h)}" title="移除">×</button></span>`
  ).join('');
  wrap.querySelectorAll('button[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await send({ type: 'REMOVE_ALLOW', handle: btn.dataset.remove });
      loadSettings();
    });
  });
}

$('saveJevBtn').addEventListener('click', async () => {
  const provider = $('provider').value;
  const jevService = $('jevService').value;
  const jevCustomUrl = $('jevCustomUrl').value.trim();
  const jevApiKey = $('jevApiKey').value.trim();
  const jevModel = $('jevModel').value.trim();
  const jevMode = $('jevMode').value;
  const msg = $('jevMsg');

  if (!jevApiKey) {
    msg.className = 'msg err';
    msg.textContent = '请填写 API Key（必填）。';
    return;
  }
  if (provider === 'jev' && jevService === 'custom' && !jevCustomUrl) {
    msg.className = 'msg err';
    msg.textContent = '请填写自定义 Jev 接口地址。';
    return;
  }

  await send({ type: 'SET_CONFIG', config: { provider, jevService, jevCustomUrl, jevApiKey, jevModel, jevMode } });
  msg.className = 'msg ok';
  msg.textContent = '配置已保存。';
  loadSettings();
});

$('pingBtn').addEventListener('click', async () => {
  const msg = $('jevMsg');
  $('pingBtn').disabled = true;
  msg.className = 'msg';
  msg.textContent = '正在测试连接…';
  const res = await send({ type: 'JEV_PING' });
  $('pingBtn').disabled = false;
  if (res?.ok) {
    const scoreTxt = typeof res.score === 'number' ? ` · 测试样条 AI ${Math.round(res.score * 100)}%` : '';
    msg.className = 'msg ok';
    msg.textContent = `连接成功：${res.ms} ms · ${res.model}${scoreTxt}${res.mock ? '（Mock 模式）' : ''}`;
  } else {
    msg.className = 'msg err';
    msg.textContent = `测试失败：${res?.reason || '无响应'}`;
  }
});

$('saveGeneralBtn').addEventListener('click', async () => {
  const aiThreshold = Math.min(0.95, Math.max(0.05, Number($('aiThreshold').value) / 100));
  await send({
    type: 'SET_CONFIG',
    config: {
      detectEnabled: $('detectEnabled').checked,
      aiThreshold,
      browseScope: $('browseScope').value
    }
  });
  const msg = $('generalMsg');
  msg.className = 'msg ok';
  msg.textContent = '探测设置已保存。';
  loadSettings();
});

$('importPromptBtn').addEventListener('click', async () => {
  const msg = $('promptJsonMsg');
  try {
    const parsed = JSON.parse($('promptJson').value);
    if (!parsed || typeof parsed.instructions !== 'string' || !parsed.instructions.trim()) {
      throw new Error('缺少有效的 instructions 字段');
    }
    await send({ type: 'SET_CONFIG', config: { promptConfig: parsed } });
    msg.className = 'msg ok';
    msg.textContent = '✅ 已导入提示词与阈值配置并立即生效';
    loadSettings();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = `JSON 格式错误：${e.message || e}`;
  }
});

$('copyPromptBtn').addEventListener('click', async () => {
  const msg = $('promptJsonMsg');
  try {
    await navigator.clipboard.writeText($('promptJson').value);
    msg.className = 'msg ok';
    msg.textContent = '已复制到剪贴板，可直接粘贴到标注系统回归页';
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '复制失败，请手动全选复制';
  }
});

$('resetPromptBtn').addEventListener('click', async () => {
  const msg = $('promptJsonMsg');
  const res = await send({ type: 'RESET_PROMPT_CONFIG' });
  if (res?.ok) {
    msg.className = 'msg ok';
    msg.textContent = '✅ 已恢复为扩展内置默认提示词与阈值，并清空缓存';
    loadSettings();
  } else {
    msg.className = 'msg err';
    msg.textContent = '恢复默认配置失败';
  }
});

let recPage = 1;
const REC_SIZE = 30;
let recTotal = 0;

function statusText(s) {
  return {
    normal: '正常',
    detected: '高 AI（未屏蔽）',
    blocked: '已屏蔽',
    failed: '屏蔽失败',
    unblocking: '待解除屏蔽',
    unblocked: '已解除（误判）'
  }[s] || s || '-';
}

async function loadRecords() {
  const [st, res] = await Promise.all([
    AXAI_STORE.stats(),
    AXAI_STORE.query({
      filter: $('recFilter').value,
      q: $('recSearch').value.trim().toLowerCase(),
      page: recPage,
      size: REC_SIZE
    })
  ]);
  $('recStats').textContent = `累计探测 ${st.total} · 高 AI ${st.flagged}`;
  recTotal = res.total;
  const maxPage = Math.max(1, Math.ceil(recTotal / REC_SIZE));
  $('pageInfo').textContent = `${recPage} / ${maxPage}（共 ${recTotal} 条）`;
  $('prevPage').disabled = recPage <= 1;
  $('nextPage').disabled = recPage >= maxPage;

  const tbody = $('recBody');
  if (!res.rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无记录</td></tr>';
    return;
  }
  tbody.innerHTML = res.rows.map(r => {
    const score = typeof r.score === 'number' ? Math.round(r.score * 100) : null;
    const cls = score == null ? 'low' : score >= 60 ? 'high' : score >= 40 ? 'mid' : 'low';
    const time = r.checkedAt ? new Date(r.checkedAt).toLocaleString() : '';
    return `<tr>
      <td>
        <div><b>${escapeHtml(r.name || r.handle)}</b></div>
        <div class="muted"><a href="${escapeHtml(r.profileUrl || `https://x.com/${r.handle}`)}" target="_blank">@${escapeHtml(r.handle)}</a></div>
      </td>
      <td>
        <span class="score ${cls}">${score == null ? '-' : `AI ${score}%`}</span>
        <div class="muted">${r.mock ? 'Mock' : (r.detector || 'jev')}</div>
      </td>
      <td>
        <div>${escapeHtml(r.text || '(无文字)')}</div>
        <div class="muted">${escapeHtml(r.error ? `错误：${r.error}` : (r.reason || ''))}${r.statusUrl ? ` · <a href="${escapeHtml(r.statusUrl)}" target="_blank">查看回复</a>` : ''}</div>
        <div class="muted">${escapeHtml(time)}</div>
      </td>
      <td>${escapeHtml(statusText(r.status))}</td>
      <td>
        ${r.falsePositive ? '<span class="muted">已标误判</span>' : `<button type="button" data-fp="${escapeHtml(r.handle)}">误判</button>`}
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-fp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const h = btn.dataset.fp;
      if (!confirm(`将 @${h} 标为误判并加入白名单？如果已屏蔽，将在打开 X 页面时自动解除屏蔽。`)) return;
      await send({ type: 'MARK_FALSE_POSITIVE', handle: h });
      AXAI_STORE.invalidate();
      loadRecords();
      loadSettings();
    });
  });
}

$('recFilter').addEventListener('change', () => { recPage = 1; loadRecords(); });
$('recSearch').addEventListener('input', () => { recPage = 1; loadRecords(); });
$('prevPage').addEventListener('click', () => { if (recPage > 1) { recPage--; loadRecords(); } });
$('nextPage').addEventListener('click', () => { recPage++; loadRecords(); });

$('exportBtn').addEventListener('click', async () => {
  const rows = await AXAI_STORE.all();
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `anti-xai-records-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('确认清空全部探测记录？此操作不可撤销。')) return;
  await AXAI_STORE.clear();
  recPage = 1;
  loadRecords();
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'DETECT_LOG_CHANGED') {
    AXAI_STORE.invalidate();
    if ($('panel-records').classList.contains('active')) loadRecords();
  }
});

loadSettings();
const initialTab = location.hash.replace('#', '');
if (['settings', 'records'].includes(initialTab)) activateTab(initialTab);
