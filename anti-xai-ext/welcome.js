const $ = id => document.getElementById(id);
const send = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));

function syncProviderUI() {
  const isGemini = $('provider').value === 'gemini';
  $('jevServiceWrap').style.display = isGemini ? 'none' : 'block';
  $('customUrlWrap').style.display = !isGemini && $('jevService').value === 'custom' ? 'block' : 'none';
  $('apiKeyLabel').textContent = isGemini ? 'Gemini API Key（必填）' : 'Jev API Key（必填）';
  $('jevApiKey').placeholder = isGemini
    ? '粘贴 Google AI Studio GEMINI_API_KEY'
    : '粘贴 Jev API Key';
}

async function init() {
  const { provider = 'jev', jevService = 'official', jevCustomUrl = '', jevApiKey = '' } =
    await chrome.storage.local.get(['provider', 'jevService', 'jevCustomUrl', 'jevApiKey']);
  $('provider').value = provider === 'gemini' ? 'gemini' : 'jev';
  $('jevService').value = jevService;
  $('jevCustomUrl').value = jevCustomUrl;
  $('jevApiKey').value = jevApiKey;
  syncProviderUI();
}

$('provider').addEventListener('change', syncProviderUI);
$('jevService').addEventListener('change', syncProviderUI);

$('saveKeyBtn').addEventListener('click', async () => {
  const provider = $('provider').value;
  const jevService = $('jevService').value;
  const jevCustomUrl = $('jevCustomUrl').value.trim();
  const jevApiKey = $('jevApiKey').value.trim();
  const out = $('keyResult');

  if (!jevApiKey) {
    out.className = 'result err';
    out.textContent = '请填写 API Key（必填）。';
    return;
  }
  if (provider === 'jev' && jevService === 'custom' && !jevCustomUrl) {
    out.className = 'result err';
    out.textContent = '选择自定义接口时，请填写接口 URL。';
    return;
  }

  await send({ type: 'SET_CONFIG', config: { provider, jevService, jevCustomUrl, jevApiKey } });
  $('saveKeyBtn').disabled = true;
  out.className = 'result';
  out.textContent = '已保存，正在测试连接…';
  const res = await send({ type: 'JEV_PING' });
  $('saveKeyBtn').disabled = false;

  if (res?.ok) {
    const scoreTxt = typeof res.score === 'number' ? ` · 测试样条 AI ${Math.round(res.score * 100)}%` : '';
    out.className = 'result ok';
    out.textContent = `连接成功（${res.ms} ms · ${res.model}${scoreTxt}）${res.mock ? ' — 当前为 Mock 模式' : ''}`;
  } else {
    out.className = 'result err';
    out.textContent = `连接失败：${res?.reason || '没有响应'}`;
  }
});

$('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('doneBtn').addEventListener('click', () => { location.href = 'https://x.com/home'; });

init();
