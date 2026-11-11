// FRIDO DEV BOT — created & designed by FRIDO (FRIDO DEV TECH).
// Phone powered. Owner controlled. Public by choice.
const $ = id => document.getElementById(id);
const local = ['127.0.0.1', 'localhost'].includes(location.hostname) && !new URLSearchParams(location.search).has('guide');
const activeStates = new Set(['starting', 'connecting', 'awaiting_link', 'connected', 'reconnecting']);
let token = '';
let current = null;
let mode = 'code';
let submitting = false;
let polling = false;
let available = false;
let requestVersion = 0;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let motionPaused = false;
try { motionPaused = sessionStorage.getItem('frido-motion-paused') === 'true'; } catch {}
function updateMotion() {
  const paused = motionPaused || reducedMotion.matches;
  document.body.dataset.motion = paused ? 'paused' : 'running';
  $('motion-toggle').setAttribute('aria-pressed', String(paused));
  $('motion-toggle').textContent = reducedMotion.matches ? 'Motion reduced' : paused ? 'Resume motion' : 'Pause motion';
  $('motion-toggle').disabled = reducedMotion.matches;
  if (paused) document.documentElement.dataset.reveal = 'false';
}
$('motion-toggle').addEventListener('click', () => {
  motionPaused = !motionPaused;
  try { sessionStorage.setItem('frido-motion-paused', String(motionPaused)); } catch {}
  updateMotion();
});
reducedMotion.addEventListener('change', updateMotion);
updateMotion();
if (!reducedMotion.matches && !motionPaused && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.06 });
  document.documentElement.dataset.reveal = 'true';
  document.querySelectorAll('.reveal').forEach(element => observer.observe(element));
}
function updateVisibility() { document.body.dataset.pageHidden = String(document.hidden); }
updateVisibility();
document.addEventListener('visibilitychange', updateVisibility);

async function copyField(field, feedback) {
  try {
    await navigator.clipboard.writeText(field.value);
    feedback.textContent = 'Copied. Ready to paste.';
  } catch {
    field.focus();
    field.select();
    feedback.textContent = 'Text selected. Press and hold, then choose Copy.';
  }
}

$('copy-install-button').addEventListener('click', () => copyField($('install-command'), $('install-copy-feedback')));
$('copy-code-button').addEventListener('click', () => copyField($('pairing-code'), $('code-copy-feedback')));

if (!local && location.protocol === 'https:') {
  const origin = location.origin;
  if (/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) {
    $('install-command').value = `pkg update -y && pkg upgrade -y && pkg install -y nodejs-lts npm curl tar coreutils && curl --fail --show-error --location --proto '=https' --proto-redir '=https' '${origin}/install.sh' -o "$HOME/frido-dev-bot-install.sh" && bash "$HOME/frido-dev-bot-install.sh" '${origin}'`;
    $('command-source').textContent = location.host;
    $('command-hint').textContent = 'Run once in Termux. Keep your internet connected.';
    $('copy-install-button').disabled = false;
  }
}

document.body.dataset.environment = local ? 'local' : 'hosted';

function lock(reason) {
  token = '';
  current = null;
  available = false;
  try { sessionStorage.removeItem('still-token'); } catch {}
  $('locked-panel').hidden = false;
  $('dashboard-content').hidden = true;
  if (reason) $('locked-reason').textContent = reason;
  $('pairing-code').value = '';
  $('pairing-qr').removeAttribute('src');
}

function feedback(text, error = false) {
  $('action-feedback').textContent = text;
  $('action-feedback').hidden = !text;
  $('action-feedback').dataset.tone = error ? 'error' : 'normal';
}

function setMode(next, focus = false) {
  mode = next;
  for (const name of ['code', 'qr']) {
    const selected = name === next;
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
    $(`${name}-panel`).hidden = !selected;
  }
  if (focus) $(`${next}-tab`).focus();
  $('phone-error').hidden = true;
  $('phone-number').removeAttribute('aria-invalid');
}
for (const name of ['code', 'qr']) {
  $(`${name}-tab`).addEventListener('click', () => setMode(name));
  $(`${name}-tab`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setMode(event.key === 'Home' ? 'code' : event.key === 'End' ? 'qr' : mode === 'code' ? 'qr' : 'code', true);
    }
  });
}

function renderControls() {
  const active = activeStates.has(current?.status);
  const ready = available && !!current && !submitting;
  const saved = current?.hasSession === true;
  $('start-button').disabled = !ready || active || current?.status === 'logged_out';
  $('stop-button').disabled = !ready || !active;
  $('reconnect-button').disabled = !ready || !saved || current?.status === 'logged_out';
  $('new-session-button').disabled = !ready || active;
  $('phone-number').disabled = !ready || active || saved;
  $('code-tab').disabled = !ready || active;
  $('qr-tab').disabled = !ready || active;
  $('start-label').textContent = submitting ? 'Please wait…' : current?.status === 'connected' ? 'Bot is running' : active ? 'Connection in progress' : saved ? 'Start saved session' : 'Start & link WhatsApp';
  $('saved-session').hidden = !saved;
  $('link-options').hidden = !current || saved || current.status === 'logged_out';
  $('controls-intro').textContent = !available ? 'The local service must be available to use these controls.' : saved ? 'Your login stays on this phone. Stopping does not log you out.' : current?.status === 'logged_out' ? 'Choose New session below to archive the old login and link again.' : 'Choose how to link. Use a phone code on this phone, or QR with a second screen.';
}

const labels = {
  stopped: ['System standing by.', 'The local console is running. Your WhatsApp bot is stopped.'],
  starting: ['Initializing runtime…', 'Preparing the saved session or a new WhatsApp connection.'],
  connecting: ['Establishing connection…', 'Waiting for WhatsApp. This is not a confirmed connection yet.'],
  awaiting_link: ['Authorization required.', 'Finish linking in WhatsApp using the details below.'],
  connected: ['Connection established.', 'FRIDO DEV BOT is listening. Send .alive in your self-chat to test it. You can close the browser; keep Termux running.'],
  reconnecting: ['Restoring connection…', 'Reconnecting with the saved session. No confirmed connection yet.'],
  logged_out: ['Session revoked.', 'WhatsApp logged out this session. Archive it below, then link again.'],
  error: ['Connection interrupted.', 'The bot is not connected. Check the details below.'],
};

function render(state) {
  current = state;
  available = true;
  const [heading, description] = labels[state.status] || ['Unknown state', 'The local service returned an unrecognized state.'];
  $('connection-card').dataset.state = state.status;
  $('connection-heading').textContent = heading;
  $('connection-description').textContent = description;
  $('connection-icon').setAttribute('href', state.status === 'connected' ? '#i-check' : '#i-phone');
  $('service-error').textContent = state.error || '';
  $('service-error').hidden = !state.error;
  $('retry-button').hidden = true;
  $('connection-metrics').hidden = state.status !== 'connected';
  $('account-value').textContent = state.account ? `+${state.account}` : 'Unknown';
  $('messages-value').textContent = Number.isFinite(state.messages) ? String(state.messages) : '—';
  const seconds = state.connectedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(state.connectedAt)) / 1000)) : 0;
  $('elapsed-value').textContent = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  if (activeStates.has(state.status)) setMode(state.mode === 'qr' ? 'qr' : 'code');
  const linking = state.status === 'awaiting_link';
  const hasCode = linking && typeof state.pairingCode === 'string' && state.pairingCode.length > 0;
  const hasQr = linking && typeof state.qr === 'string' && state.qr.startsWith('data:image/svg+xml;base64,');
  $('pairing-panel').hidden = !linking;
  $('pairing-code-panel').hidden = !hasCode;
  $('pairing-qr-panel').hidden = !hasQr;
  $('pairing-waiting').hidden = !!(hasCode || hasQr);
  $('pairing-beta').hidden = state.mode !== 'code';
  $('pairing-code').value = hasCode ? state.pairingCode : '';
  if (hasQr) $('pairing-qr').src = state.qr;
  else $('pairing-qr').removeAttribute('src');
  $('pairing-description').textContent = state.mode === 'code'
    ? 'WhatsApp → three dots → Linked devices → Link a device → Link with phone number instead. Enter this code, then return here to check the connection.'
    : 'Show this QR on a second screen you control (for example, by mirroring this screen). On this phone, open WhatsApp → Linked devices → Link a device and scan it before it expires.';
  if (!linking) $('code-copy-feedback').textContent = '';
  renderControls();
}

function unavailable(message) {
  available = false;
  $('connection-card').dataset.state = 'unavailable';
  $('connection-heading').textContent = 'Local service unavailable.';
  $('connection-description').textContent = 'Open the FRIDO DEV BOT shortcut in Termux to start or reopen the local service.';
  $('service-error').textContent = message;
  $('service-error').hidden = !message;
  $('connection-metrics').hidden = true;
  $('retry-button').hidden = false;
  $('pairing-panel').hidden = true;
  $('pairing-code').value = '';
  $('pairing-qr').removeAttribute('src');
  renderControls();
}

async function api(route, body) {
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Still-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store', signal: AbortSignal.timeout(12000),
  });
  if (response.status === 401) {
    lock('This dashboard access has expired. Open the FRIDO DEV BOT widget shortcut again to unlock it.');
    throw new Error('Dashboard locked. Open the widget shortcut again.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The local request failed.');
  return result;
}

async function refresh() {
  if (!local || !token || polling || submitting || document.hidden) return;
  polling = true;
  const version = requestVersion;
  try {
    const result = await api('status');
    if (token && version === requestVersion) render(result);
  } catch (err) {
    if (token && version === requestVersion) unavailable(err.message);
  } finally { polling = false; }
}

async function action(route, body = {}) {
  if (submitting || !token) return;
  submitting = true;
  ++requestVersion;
  feedback('Sending request…');
  renderControls();
  try {
    await api(route, body);
    feedback(route === 'stop' ? 'Stop request accepted. Your saved login is kept.' : route === 'new-session' ? 'The old local login was archived. You can link again.' : 'Request accepted. Watch the connection status for confirmation.');
  } catch (err) { feedback(err.message, true); }
  finally {
    submitting = false;
    renderControls();
    await refresh();
  }
}

$('start-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($('start-button').disabled) return;
  const body = current?.hasSession ? {} : { mode, phoneNumber: $('phone-number').value };
  if (!current?.hasSession && mode === 'code') {
    const input = $('phone-number').value.trim();
    const number = input.replace(/\D/g, '');
    if (!/^[+\d\s()-]+$/.test(input) || !/^[1-9]\d{7,14}$/.test(number)) {
      $('phone-error').textContent = 'Enter your WhatsApp number with country code: 8–15 digits, no leading zero.';
      $('phone-error').hidden = false;
      $('phone-number').setAttribute('aria-invalid', 'true');
      $('phone-number').focus();
      return;
    }
    body.phoneNumber = number;
  }
  $('phone-error').hidden = true;
  $('phone-number').removeAttribute('aria-invalid');
  void action('start', body);
});
$('stop-button').addEventListener('click', () => action('stop'));
$('reconnect-button').addEventListener('click', () => action('reconnect'));
$('retry-button').addEventListener('click', refresh);
$('new-session-button').addEventListener('click', () => $('new-session-dialog').showModal());
$('confirm-session-button').addEventListener('click', () => {
  $('new-session-dialog').close();
  void action('new-session');
});

if (local) {
  $('dashboard').hidden = false;
  $('setup').hidden = true;
  $('hero-cta').href = '#dashboard';
  $('hero-cta').firstChild.textContent = 'Open control console ';
  document.querySelector('.main-nav a').href = '#dashboard';
  document.querySelector('.main-nav a').textContent = 'Your bot';
  for (const link of document.querySelectorAll('.nav-dashboard')) {
    link.href = '#dashboard';
    link.removeAttribute('target');
  }
  $('environment-copy').textContent = 'This dashboard talks only to the bot on this device. The hosted website cannot access your login or controls.';
  $('environment-label').textContent = 'ON THIS DEVICE';
  try {
    const incoming = new URLSearchParams(location.hash.slice(1)).get('token');
    if (incoming && /^[a-f0-9]{64}$/.test(incoming)) sessionStorage.setItem('still-token', incoming);
    if (incoming) history.replaceState(null, '', location.pathname + location.search);
    token = sessionStorage.getItem('still-token') || '';
  } catch { lock('Browser session storage is disabled. Allow it for this local dashboard, then reopen the shortcut.'); }
  if (!token) lock();
  else {
    $('locked-panel').hidden = true;
    $('dashboard-content').hidden = false;
    void refresh();
  }
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(location.hash.slice(1)).has('token')) location.reload();
  });
  setInterval(refresh, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}
