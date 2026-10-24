const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const loginSection = $('login'); const workspace = $('workspace'); const screen = $<HTMLImageElement>('screen');
const screenBox = $('screen-box'); const keyboardCapture = $<HTMLTextAreaElement>('keyboard-capture');
let ws: WebSocket | null = null; let mine = false; let rotation = 0; let currentUrl = '';
let remoteTextFocused = false; let composing = false; let focusLossTimer: number | undefined;
let audioContext: AudioContext | null = null; let nextAudioTime = 0;
function notice(message: string) { $('notice').textContent = message; }
async function api(url: string, method = 'GET', body?: unknown) {
  const options: RequestInit = { method, credentials: 'same-origin' };
  if (body !== undefined) { options.headers = { 'content-type': 'application/json' }; options.body = JSON.stringify(body); }
  const response = await fetch(url, options);
  if (response.status === 401) { showLogin(); throw new Error('Please sign in again'); }
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || response.statusText);
  return json;
}
function showLogin() { clearCiToken(); keyboardCapture.blur(); screenBox.blur(); workspace.hidden = true; loginSection.hidden = false; $('connection').textContent = 'Sign-in required'; $('connection').classList.remove('online'); ws?.close(); ws = null; }
function showWorkspace() { loginSection.hidden = true; workspace.hidden = false; connect(); refresh(); }
async function refresh() {
  try {
    const status = await api('/api/status');
    mine = Boolean(status.mine);
    $('device-status').textContent = `${status.emulator} · ${status.lease ? status.lease + ' control' : 'available'}`;
    $('connection').textContent = status.emulator === 'online' ? 'Online' : status.emulator;
    $('connection').classList.toggle('online', status.emulator === 'online');
    $('lease-btn').textContent = mine ? 'Release control' : 'Take control';
    $('input-help').hidden = mine;
    document.querySelectorAll<HTMLButtonElement>('[data-key],#rotate,#finger-match,#finger-reject,#camera-form button,#camera-reset,#text-form button').forEach(b => b.disabled = !mine);
    $<HTMLButtonElement>('keyboard-btn').disabled = !mine;
    if (!mine && screenBox.contains(document.activeElement)) { keyboardCapture.blur(); screenBox.blur(); }
  } catch { /* login handler updates the page */ }
}
function playAudio(data: ArrayBuffer) {
  if (!audioContext) return;
  const pcm = new Int16Array(data.slice(1)); const samples = Math.floor(pcm.length / 2); if (!samples) return;
  const buffer = audioContext.createBuffer(2, samples, 44100);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  for (let i = 0; i < samples; i++) { left[i] = pcm[i * 2] / 32768; right[i] = pcm[i * 2 + 1] / 32768; }
  const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination);
  if (nextAudioTime < audioContext.currentTime || nextAudioTime > audioContext.currentTime + .5) nextAudioTime = audioContext.currentTime + .12;
  source.start(nextAudioTime); nextAudioTime += buffer.duration;
}
function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/device`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { if (audioContext) ws?.send(JSON.stringify({ type: 'audio', enabled: true })); };
  ws.onmessage = event => {
    if (!(event.data instanceof ArrayBuffer)) { try { const msg = JSON.parse(event.data); if (msg.type === 'text-focus') setRemoteTextFocus(Boolean(msg.focused)); else notice(msg.message || ''); } catch {} return; }
    const kind = new Uint8Array(event.data, 0, 1)[0];
    if (kind === 1) {
      const blob = new Blob([event.data.slice(1)], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const previous = currentUrl;
      const displayed = () => {
        if (previous) URL.revokeObjectURL(previous);
        requestAnimationFrame(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'frame-ack' })); });
      };
      screen.onload = displayed;
      screen.onerror = displayed;
      screen.src = url;
      currentUrl = url;
    } else if (kind === 2) playAudio(event.data);
  };
  ws.onclose = () => { ws = null; if (!workspace.hidden) setTimeout(connect, 2000); };
}
function send(message: unknown) { if (!mine) return; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
$<HTMLFormElement>('login-form').onsubmit = async event => {
  event.preventDefault(); $('login-error').textContent = '';
  try { await api('/api/login', 'POST', { password: $<HTMLInputElement>('password').value }); $<HTMLInputElement>('password').value = ''; showWorkspace(); }
  catch (e) { $('login-error').textContent = String(e); }
};
$('logout').onclick = async () => { await api('/api/logout', 'POST', {}); showLogin(); };
$('lease-btn').onclick = async () => { try { await api('/api/lease', mine ? 'DELETE' : 'POST'); await refresh(); } catch (e) { notice(String(e)); } };
setInterval(async () => { if (workspace.hidden) return; if (mine) { try { await api('/api/lease/heartbeat', 'POST', {}); } catch { mine = false; } } await refresh(); }, 15000);
let down = false;
let lastMoveAt = 0;
function openKeyboard() {
  if (!mine) return;
  keyboardCapture.focus({ preventScroll: true });
  try { (navigator as Navigator & { virtualKeyboard?: { show(): void } }).virtualKeyboard?.show(); } catch { /* focusing the textarea is the fallback */ }
}
function setRemoteTextFocus(focused: boolean) {
  remoteTextFocused = focused;
  if (focusLossTimer) clearTimeout(focusLossTimer);
  if (focused && mine && matchMedia('(pointer: coarse)').matches) {
    if (!down) openKeyboard();
  } else if (!focused && document.activeElement === keyboardCapture) {
    focusLossTimer = window.setTimeout(() => { if (!remoteTextFocused) keyboardCapture.blur(); }, 250);
  }
}
screenBox.addEventListener('dragstart', event => event.preventDefault());
screenBox.addEventListener('selectstart', event => event.preventDefault());
screenBox.addEventListener('contextmenu', event => event.preventDefault());
screen.addEventListener('mousedown', event => event.preventDefault());
function pointer(e: PointerEvent, pressed: boolean) {
  const rect = screen.getBoundingClientRect();
  const style = getComputedStyle(screen);
  const left = parseFloat(style.borderLeftWidth) || 0;
  const right = parseFloat(style.borderRightWidth) || 0;
  const top = parseFloat(style.borderTopWidth) || 0;
  const bottom = parseFloat(style.borderBottomWidth) || 0;
  send({
    type: 'touch',
    x: (e.clientX - rect.left - left) / (rect.width - left - right),
    y: (e.clientY - rect.top - top) / (rect.height - top - bottom),
    down: pressed,
  });
}
screen.onpointerdown = e => { e.preventDefault(); if (!mine || e.button !== 0) return; screenBox.focus({ preventScroll: true }); down = true; lastMoveAt = 0; screen.setPointerCapture(e.pointerId); pointer(e, true); };
screen.onpointermove = e => { if (down) { e.preventDefault(); if (performance.now() - lastMoveAt >= 33) { lastMoveAt = performance.now(); pointer(e, true); } } };
screen.onpointerup = e => { if (down) { e.preventDefault(); pointer(e, false); down = false; if (remoteTextFocused && matchMedia('(pointer: coarse)').matches) openKeyboard(); } };
screen.onpointercancel = e => { if (down) { e.preventDefault(); pointer(e, false); down = false; } };
$('keyboard-btn').onclick = openKeyboard;
const directKeys = new Set(['Backspace', 'Delete', 'Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
screenBox.addEventListener('keydown', event => {
  if (!mine || (event.target !== screenBox && event.target !== keyboardCapture)) return;
  if (event.key === 'Escape') { event.preventDefault(); keyboardCapture.blur(); screenBox.blur(); return; }
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (directKeys.has(event.key)) { event.preventDefault(); send({ type: 'key', key: event.key }); return; }
  if (event.target !== keyboardCapture && event.key.length === 1) { event.preventDefault(); send({ type: 'text', text: event.key }); }
});
screenBox.addEventListener('paste', event => {
  if (!mine || event.target === keyboardCapture) return;
  event.preventDefault();
  const value = event.clipboardData?.getData('text/plain');
  if (value) send({ type: 'text', text: value.slice(0, 2000) });
});
keyboardCapture.addEventListener('beforeinput', event => {
  if (!mine) return;
  if (event.inputType.startsWith('delete')) { event.preventDefault(); send({ type: 'key', key: event.inputType.includes('Forward') ? 'Delete' : 'Backspace' }); }
  else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') { event.preventDefault(); send({ type: 'key', key: 'Enter' }); }
});
function flushKeyboard() {
  if (!keyboardCapture.value) return;
  const value = keyboardCapture.value;
  keyboardCapture.value = '';
  if (mine) send({ type: 'text', text: value.slice(0, 2000) });
}
keyboardCapture.addEventListener('input', event => { if (!composing && !(event as InputEvent).isComposing) flushKeyboard(); });
keyboardCapture.addEventListener('compositionstart', () => { composing = true; });
keyboardCapture.addEventListener('compositionend', () => { composing = false; window.setTimeout(flushKeyboard, 0); });
$<HTMLFormElement>('text-form').onsubmit = e => { e.preventDefault(); const input = $<HTMLInputElement>('text-input'); if (input.value) send({ type: 'text', text: input.value }); input.value = ''; };
document.querySelectorAll<HTMLButtonElement>('[data-key]').forEach(button => button.onclick = async () => { try { await api('/api/device-key', 'POST', { key: button.dataset.key }); } catch (e) { notice(String(e)); } });
$('rotate').onclick = async () => { rotation = (rotation + 1) % 4; try { await api('/api/rotate', 'POST', { rotation }); } catch (e) { notice(String(e)); } };
async function finger(id: number) { send({ type: 'fingerprint', id, down: true }); setTimeout(() => send({ type: 'fingerprint', id, down: false }), 180); }
$('finger-match').onclick = () => finger(1); $('finger-reject').onclick = () => finger(9999);
$('screenshot').onclick = async () => { const response = await fetch('/api/screenshot'); if (!response.ok) return notice('Screenshot unavailable'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `android-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); };
$('audio-btn').onclick = async () => { if (audioContext) { await audioContext.close(); audioContext = null; $('audio-btn').textContent = 'Enable speaker audio'; } else { audioContext = new AudioContext({ sampleRate: 44100 }); await audioContext.resume(); nextAudioTime = 0; $('audio-btn').textContent = 'Mute speaker audio'; } if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio', enabled: Boolean(audioContext) })); };
$<HTMLFormElement>('camera-form').onsubmit = async e => {
  e.preventDefault(); const file = $<HTMLInputElement>('camera-file').files?.[0]; if (!file) return;
  notice('Preparing camera feed and restarting the emulator…');
  const form = new FormData(); form.set('file', file);
  try { const response = await fetch('/api/camera', { method: 'POST', body: form }); const data = await response.json(); if (!response.ok) throw new Error(data.error); notice('Camera source applied. Waiting for Android to boot…'); }
  catch (err) { notice(String(err)); }
};
$('camera-reset').onclick = async () => { try { notice('Restoring the default camera…'); await api('/api/camera/reset', 'POST', {}); notice('Default camera restored. Waiting for Android to boot…'); } catch (e) { notice(String(e)); } };

type InstalledApp = { packageName: string; activity: string; label: string };
type CapabilityEntry = { name: string; category: string; description: string };
type Capabilities = { required: Record<string, string>; defaults: Record<string, boolean | number>; driverVersion: string; entries: CapabilityEntry[] };
let capabilityData: Capabilities | null = null;
let installedApps: InstalledApp[] = [];
let capabilitiesLoaded = false;
let ciTokenTimer: number | undefined;

function clearCiToken() {
  if (ciTokenTimer) clearTimeout(ciTokenTimer);
  ciTokenTimer = undefined;
  $<HTMLInputElement>('ci-token-value').value = '';
  $<HTMLInputElement>('ci-token-value').type = 'password';
  $('ci-token-reveal').textContent = 'Show';
  $('ci-token-copy-status').textContent = '';
  $('ci-token-result').hidden = true;
}
$('webdriver-url').textContent = `${location.origin}/webdriver`;
$('session-url').textContent = `${location.origin}/webdriver/session`;
$<HTMLFormElement>('ci-token-form').onsubmit = async event => {
  event.preventDefault();
  const password = $<HTMLInputElement>('ci-password');
  const button = $<HTMLFormElement>('ci-token-form').querySelector<HTMLButtonElement>('button[type="submit"]')!;
  $('ci-token-error').textContent = '';
  clearCiToken(); button.disabled = true;
  try {
    const result = await api('/api/ci-token', 'POST', { password: password.value });
    $<HTMLInputElement>('ci-token-value').value = result.token;
    $('ci-token-expiry').textContent = `Valid for ${result.date} in Bangkok. Expires at midnight (Asia/Bangkok). This page hides it after 60 seconds.`;
    $('ci-token-result').hidden = false;
    ciTokenTimer = window.setTimeout(clearCiToken, Math.min(60_000, Math.max(1, Date.parse(result.expiresAt) - Date.now())));
  } catch (error) { $('ci-token-error').textContent = String(error); }
  finally { password.value = ''; button.disabled = false; }
};
$('ci-token-reveal').onclick = () => {
  const field = $<HTMLInputElement>('ci-token-value');
  field.type = field.type === 'password' ? 'text' : 'password';
  $('ci-token-reveal').textContent = field.type === 'password' ? 'Show' : 'Hide';
};
$('ci-token-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($<HTMLInputElement>('ci-token-value').value); $('ci-token-copy-status').textContent = 'Token copied.'; }
  catch { $('ci-token-copy-status').textContent = 'Copy failed. Show and copy the token manually.'; }
};

function showView(view: 'device' | 'capabilities') {
  if (view !== 'capabilities') clearCiToken();
  $('device-view').hidden = view !== 'device';
  $('capabilities-view').hidden = view !== 'capabilities';
  for (const name of ['device', 'capabilities'] as const) {
    const button = $<HTMLButtonElement>(`${name}-tab`);
    button.classList.toggle('active', name === view);
    button.setAttribute('aria-selected', String(name === view));
  }
  if (view === 'capabilities' && !capabilitiesLoaded) void loadCapabilities();
}
$('device-tab').onclick = () => showView('device');
$('capabilities-tab').onclick = () => showView('capabilities');

function renderValues(containerId: string, values: Record<string, string | boolean | number>, descriptions: Record<string, string>) {
  const container = $(containerId); container.replaceChildren();
  for (const [name, value] of Object.entries(values)) {
    const row = document.createElement('div'); row.className = 'cap-value';
    const key = document.createElement('code'); key.textContent = name;
    const current = document.createElement('span'); current.textContent = String(value);
    const description = document.createElement('small'); description.textContent = descriptions[name] || '';
    row.append(key, current, description); container.append(row);
  }
}
function selectedApp() { return installedApps.find(app => `${app.packageName}/${app.activity}` === $<HTMLSelectElement>('focus-app').value); }
function renderPayload() {
  const app = selectedApp();
  const values: Record<string, string | boolean | number> = {
    ...(capabilityData?.required || { platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': 'emulator-5554' }),
    ...(capabilityData?.defaults || { 'appium:noReset': true, 'appium:newCommandTimeout': 300 })
  };
  if (app) {
    values['appium:appPackage'] = app.packageName;
    values['appium:appActivity'] = app.activity;
    values['appium:forceAppLaunch'] = true;
  }
  $('client-caps-json').textContent = JSON.stringify(values, null, 2);
  const requestBody = JSON.stringify({ capabilities: { alwaysMatch: values, firstMatch: [{}] } }, null, 2);
  $('capabilities-json').textContent = requestBody;
  $('request-example').textContent = [
    '$headers = @{ Authorization = "Bearer $env:GATEWAY_CI_TOKEN" }',
    "$body = @'",
    requestBody,
    "'@",
    `Invoke-RestMethod -Method Post -Uri '${location.origin}/webdriver/session' -Headers $headers -ContentType 'application/json' -Body $body`,
  ].join('\n');
  const details = $('focus-details'); details.hidden = !app;
  if (app) details.textContent = `Package: ${app.packageName}    Launch activity: ${app.activity}`;
  $('copy-status').textContent = '';
  $('body-copy-status').textContent = '';
  $('request-copy-status').textContent = '';
}
function renderCatalog() {
  const list = $('capability-list'); list.replaceChildren();
  const query = $<HTMLInputElement>('capability-search').value.trim().toLowerCase();
  const matches = (capabilityData?.entries || []).filter(entry => `${entry.name} ${entry.category} ${entry.description}`.toLowerCase().includes(query));
  if (!matches.length) { const empty = document.createElement('p'); empty.className = 'no-results'; empty.textContent = 'No matching capabilities'; list.append(empty); return; }
  const fragment = document.createDocumentFragment();
  for (const entry of matches) {
    const details = document.createElement('details'); const summary = document.createElement('summary');
    const name = document.createElement('code'); name.textContent = entry.name;
    const category = document.createElement('span'); category.textContent = entry.category;
    const description = document.createElement('p'); description.textContent = entry.description;
    summary.append(name, category); details.append(summary, description); fragment.append(details);
  }
  list.append(fragment);
}
async function loadApps() {
  $('app-list-status').textContent = 'Reading launchable apps from Android…';
  try {
    const previous = $<HTMLSelectElement>('focus-app').value;
    const result = await api('/api/apps'); installedApps = result.apps;
    const select = $<HTMLSelectElement>('focus-app'); select.replaceChildren();
    const home = document.createElement('option'); home.value = ''; home.textContent = 'Home screen (no app focus)'; select.append(home);
    for (const app of installedApps) {
      const option = document.createElement('option'); option.value = `${app.packageName}/${app.activity}`;
      option.textContent = `${app.label} — ${app.packageName}`; select.append(option);
    }
    if (installedApps.some(app => `${app.packageName}/${app.activity}` === previous)) select.value = previous;
    $('app-list-status').textContent = `${installedApps.length} launchable apps found. Background-only packages are excluded.`;
    renderPayload();
  } catch (error) { $('app-list-status').textContent = `Could not read apps: ${String(error)}`; }
}
async function loadCapabilities() {
  capabilitiesLoaded = true;
  renderPayload();
  void loadApps();
  try {
    const data: Capabilities = await api('/api/capabilities');
    capabilityData = data;
    renderValues('required-caps', data.required, {
      platformName: 'Required by Appium; pinned to Android.',
      'appium:automationName': 'Required by Appium; pinned to UiAutomator2.',
      'appium:udid': 'Pinned by this gateway to the hosted emulator.'
    });
    renderValues('default-caps', data.defaults, {
      'appium:noReset': 'Keeps app data across sessions unless your test requests a reset.',
      'appium:newCommandTimeout': 'Ends an inactive Appium session after this many seconds.'
    });
    $('capability-count').textContent = `${data.entries.length} capabilities`;
    $('catalog-source').textContent = `From installed UiAutomator2 driver ${data.driverVersion}. Select an item to read its description.`;
    renderCatalog(); renderPayload();
  } catch (error) { $('capability-count').textContent = 'Unavailable'; $('catalog-source').textContent = `Could not load capability reference: ${String(error)}`; }
}
$('refresh-apps').onclick = () => void loadApps();
$<HTMLSelectElement>('focus-app').onchange = renderPayload;
$<HTMLInputElement>('capability-search').oninput = renderCatalog;
$('copy-caps').onclick = async () => {
  try { await navigator.clipboard.writeText($('client-caps-json').textContent || ''); $('copy-status').textContent = 'Client capabilities copied.'; }
  catch { $('copy-status').textContent = 'Copy failed. Select and copy the JSON above.'; }
};
$('copy-body').onclick = async () => {
  try { await navigator.clipboard.writeText($('capabilities-json').textContent || ''); $('body-copy-status').textContent = 'Session request body copied.'; }
  catch { $('body-copy-status').textContent = 'Copy failed. Select and copy the JSON above.'; }
};
$('copy-request').onclick = async () => {
  try { await navigator.clipboard.writeText($('request-example').textContent || ''); $('request-copy-status').textContent = 'Request copied.'; }
  catch { $('request-copy-status').textContent = 'Copy failed. Select and copy the example above.'; }
};
api('/api/status').then(showWorkspace).catch(showLogin);
