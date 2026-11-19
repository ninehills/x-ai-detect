const $ = id => document.getElementById(id);
const send = msg => new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));

async function refresh() {
  const config = await send({ type: 'GET_CONFIG' });
  $('detectEnabled').checked = config?.detectEnabled !== false;

  const badge = $('jevBadge');
  const warnBox = $('needConfig');
  if (!config?.hasJevConfig) {
    badge.textContent = '未配置 API';
    badge.className = 'badge warn';
    warnBox.style.display = 'block';
  } else {
    const pct = Math.round((config.aiThreshold ?? 0.6) * 100);
    const label = config.provider === 'gemini' ? 'Gemini' : 'Jev';
    badge.textContent = `${label} · ${pct}%`;
    badge.className = 'badge ok';
    warnBox.style.display = 'none';
  }

  const t = await AXAI_STORE.today().catch(() => null);
  if (t) $('stats').textContent = `今日：探测 ${t.checked} · 高 AI ${t.flagged}`;
}

$('detectEnabled').addEventListener('change', async e => {
  await send({ type: 'SET_CONFIG', config: { detectEnabled: e.target.checked } });
  refresh();
});

$('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('logBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#records') }));

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'DETECT_LOG_CHANGED') refresh();
});

refresh();
