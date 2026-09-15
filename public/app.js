'use strict';

const $ = (s) => document.querySelector(s);
const state = {
  cfg: null, convs: [], current: null, live: '', activity: '', es: null, idleTimer: null, locked: true, usage: null,
};
const MODELS = [
  ['', 'Modèle : défaut'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];
const CONFINEMENTS = [
  ['none', 'Aucun confinement'],
  ['sandbox', 'Bac à sable'],
  ['restricted', 'Fichiers seulement'],
];
const CONF_HELP = {
  none: 'Le dossier est un simple point de départ : Claude peut agir partout où ton compte a accès (surtout en bypassPermissions).',
  sandbox: 'Bac à sable système (macOS/Linux) : les commandes tournent sans confirmation, mais l\'écriture est limitée au dossier et le réseau est coupé. Le bon mode pour les tâches longues.',
  restricted: 'Aucune commande possible : Claude ne peut que lire et écrire des fichiers dans le dossier. Fonctionne aussi sur Windows.',
};
const EFFORTS = [
  ['', 'Effort : défaut'],
  ['low', 'Faible'],
  ['medium', 'Moyen'],
  ['high', 'Élevé'],
  ['xhigh', 'Très élevé'],
  ['max', 'Max'],
];

// ---------- API ----------
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && url !== '/api/login') { showLock(); throw new Error('Session expirée'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.data = data; e.status = r.status; throw e; }
  return data;
}

// ---------- Verrouillage ----------
function showLock(msg = '') {
  state.locked = true;
  if (state.es) { state.es.close(); state.es = null; }
  clearTimeout(state.idleTimer);
  $('#messages').innerHTML = '';
  $('#convList').innerHTML = '';
  $('#usage').innerHTML = '';
  $('#convTitle').textContent = '—';
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#app').hidden = true;
  $('#lock').hidden = false;
  $('#lockMsg').textContent = msg;
  $('#pin').value = '';
  setTimeout(() => $('#pin').focus(), 50);
}

function lock() {
  if (state.locked) return;
  navigator.sendBeacon?.('/api/logout') || fetch('/api/logout', { method: 'POST', keepalive: true });
  showLock();
}

$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pin').value;
  $('#lockMsg').textContent = '';
  try {
    await api('POST', '/api/login', { pin });
    await init();
  } catch (err) {
    const wait = err.data?.retryInMs ? ` — réessaie dans ${Math.ceil(err.data.retryInMs / 1000)} s` : '';
    $('#lockMsg').textContent = (err.message || 'Erreur') + wait;
    $('#pin').value = '';
  }
});

function armIdleTimer() {
  clearTimeout(state.idleTimer);
  const min = state.cfg?.lockAfterMinutes;
  if (min > 0) state.idleTimer = setTimeout(lock, min * 60_000);
}
for (const ev of ['mousemove', 'keydown', 'pointerdown', 'touchstart', 'scroll']) {
  document.addEventListener(ev, () => { if (!state.locked) armIdleTimer(); }, { passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.cfg?.lockOnHide) lock();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !state.locked && !document.querySelector('dialog[open]')) lock();
});
$('#lockBtn').addEventListener('click', lock);

// ---------- Initialisation ----------
function fillSelect(sel, options, withDefaultLabel) {
  sel.innerHTML = '';
  for (const [value, label] of options) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = withDefaultLabel && value === '' ? withDefaultLabel : label;
    sel.appendChild(o);
  }
}

async function init() {
  state.cfg = await api('GET', '/api/me');
  state.locked = false;
  $('#lock').hidden = true;
  $('#app').hidden = false;
  const confs = state.cfg.platform === 'win32' ? CONFINEMENTS.filter(([v]) => v !== 'sandbox') : CONFINEMENTS;
  fillSelect($('#modelSel'), MODELS);
  fillSelect($('#effortSel'), EFFORTS);
  fillSelect($('#confSel'), [['', 'Confinement : défaut'], ...confs]);
  fillSelect($('#newModel'), MODELS, 'Défaut');
  fillSelect($('#newEffort'), EFFORTS, 'Défaut');
  fillSelect($('#newConf'), [['', 'Défaut'], ...confs]);
  fillSelect($('#setModel'), MODELS, 'Défaut du compte');
  fillSelect($('#setEffort'), EFFORTS, 'Défaut');
  fillSelect($('#setConf'), confs);
  renderClaudeStatus();
  renderVersion(state.cfg.update);
  armIdleTimer();
  connectEvents();
  await loadConvs();
  const last = localStorage.getItem('relay.last');
  const target = state.convs.find((c) => c.id === last) || state.convs[0];
  if (target) await openConv(target.id);
  else renderEmpty();
  refreshUsage();
}

function renderVersion(st) {
  const el = $('#versionLine');
  if (!st) { el.innerHTML = ''; return; }
  const cur = st.current || {};
  const sha = cur.sha ? ' · ' + cur.sha.slice(0, 7) : '';
  const run = st.running || {};
  const shown = st.restartNeeded ? run : cur;
  const shownSha = shown.sha ? ' · ' + shown.sha.slice(0, 7) : '';
  const hint = st.available ? 'mise à jour disponible' : st.restartNeeded ? 'redémarrage à faire' : '';
  el.innerHTML = `v${esc(shown.version || cur.version || '?')}${esc(shownSha)}${hint ? ' · <span class="avail" id="updateHint">' + hint + '</span>' : ''}`;
  void sha;
  document.getElementById('updateHint')?.addEventListener('click', () => { $('#settingsBtn').click(); });
}

function describeUpdate(st) {
  const cur = st.current || {};
  const run = st.running || {};
  const when = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '?');
  let txt = `Version installée : ${cur.version || '?'}${cur.sha ? ' (' + cur.sha.slice(0, 7) + ', ' + when(cur.date) + (cur.message ? ', « ' + cur.message + ' »' : '') + ')' : ''}.`;
  if (st.restartNeeded) txt += ` Le serveur tourne encore sur la ${run.version || '?'}${run.sha ? ' (' + run.sha.slice(0, 7) + ')' : ''} : redémarre-le pour appliquer.`;
  if (!st.repo) txt += ' Aucun dépôt GitHub configuré : renseigne-le ci-dessous.';
  else if (st.error) txt += ' ' + st.error;
  else if (!st.latest) txt += ' Clique sur Vérifier.';
  else if (st.available) txt += ` Nouvelle version disponible : « ${st.latest.message} » (${when(st.latest.date)}).`;
  else txt += ` À jour (vérifié ${when(st.checkedAt)}).`;
  if (st.available) txt += st.autoRestart ? ' Le serveur redémarrera tout seul.' : (st.platform === 'win32' ? ' Sous Windows sans service, relance le serveur après la mise à jour.' : ' Lancé à la main : il se relancera lui-même après la mise à jour.');
  return txt;
}

function renderUpdate(st) {
  if (!st) return;
  state.cfg.update = st;
  $('#updateInfo').textContent = describeUpdate(st);
  $('#updateApply').hidden = !st.available;
  $('#updateRestart').hidden = !st.restartNeeded || st.available;
  $('#updateSection').open = !st.repo;
  renderVersion(st);
}

function renderClaudeStatus() {
  const c = state.cfg;
  const model = c.model ? (MODELS.find(([v]) => v === c.model)?.[1] || c.model) : 'défaut';
  const conf = CONFINEMENTS.find(([v]) => v === c.confinement)?.[1] || '';
  $('#claudeStatus').innerHTML = c.claudeFound
    ? `claude : ok · ${esc(c.permissionMode)} · ${esc(model)}${c.effort ? ' · ' + esc(c.effort) : ''}${conf && c.confinement !== 'none' ? ' · ' + esc(conf) : ''}`
    : '<span class="bad">claude introuvable sur ce poste</span>';
}

function connectEvents() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/events');
  state.es = es;
  es.onmessage = (e) => handleEvent(JSON.parse(e.data));
  es.onerror = () => { /* reconnexion automatique par le navigateur */ };
}

// ---------- Utilisation ----------
async function refreshUsage(force = false) {
  try { renderUsage(await api('GET', '/api/usage' + (force ? '?force=1' : ''))); } catch { /* affiché via SSE sinon */ }
}
setInterval(() => { if (!state.locked) refreshUsage(); }, 5 * 60_000);

function fmtReset(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const diff = ms - Date.now();
  if (diff < 0) return 'réinitialisation imminente';
  const h = Math.floor(diff / 3_600_000);
  const rel = h >= 48 ? `dans ${Math.round(h / 24)} j` : h >= 1 ? `dans ${h} h` : `dans ${Math.max(1, Math.round(diff / 60_000))} min`;
  return `réinit. ${rel} (${d.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })})`;
}

function renderUsage(u) {
  state.usage = u;
  const box = $('#usage');
  if (!u) { box.innerHTML = ''; $('#moment').innerHTML = ''; return; }
  const p = u.policy || {};
  const byId = Object.fromEntries((u.barriers?.list || []).map((b) => [b.id, b]));
  const rows = [
    ['five_hour', 'Session 5 h', p.sessionLocalLimitPercent, byId.reserve_five_hour],
    ['seven_day', 'Semaine', p.weeklyLocalLimitPercent, byId.reserve_seven_day],
    ['seven_day_opus', 'Semaine Opus', 0, null],
    ['seven_day_sonnet', 'Semaine Sonnet', 0, null],
  ];
  let html = '';
  for (const [key, label, localLimit, reserve] of rows) {
    const w = u.data?.[key];
    if (!w) continue;
    const pct = Math.max(0, Math.min(100, w.utilization));
    const threshold = reserve ? reserve.threshold : 0;
    const cls = threshold > 0 && pct >= threshold ? 'over' : pct >= 80 ? 'warn' : '';
    const resTitle = reserve ? `Réserve maison ${reserve.reserve} %, exigée en ce moment ${reserve.required} % : arrêt à ${reserve.threshold} %` : fmtReset(w.resets_at);
    html += `<div class="bar ${cls}" title="${esc(resTitle)}"><i style="width:${pct}%"></i>${threshold > 0 ? `<b style="right:${100 - threshold}%"></b>` : ''}<span>${esc(label)} · ${Math.round(pct)} %${threshold > 0 ? ` / arrêt à ${Math.round(threshold)} %` : ''}</span></div>`;
    const l = u.local?.[key];
    if (l && (localLimit > 0 || l.points > 0 || l.cost > 0)) {
      const lp = Math.max(0, Math.min(100, l.effective));
      const lcls = localLimit > 0 && lp >= localLimit ? 'over' : localLimit > 0 && lp >= localLimit * 0.8 ? 'warn' : '';
      const cost = l.cost >= 0.01 ? ` · ${l.cost.toFixed(2)} $` : '';
      const how = l.calibrated
        ? `estimé d'après le coût des tâches (${l.samples} échantillons de calibrage) ; observé : ${Math.round(l.points)} pt`
        : `points observés ; calibrage en cours (${l.samples}/2 échantillons), l'estimation par le coût prendra le relais`;
      const lbl = l.calibrated ? `≈ ${Math.round(lp)} pt` : `${Math.round(lp)} pt`;
      html += `<div class="bar local ${lcls}" title="${esc(how)}"><i style="width:${lp}%"></i>${localLimit > 0 ? `<b style="right:${100 - localLimit}%"></b>` : ''}<span>↳ ce poste · ${lbl}${localLimit > 0 ? ` / ${localLimit}` : ''}${cost}</span></div>`;
    }
  }
  const week = u.data?.seven_day;
  if (week) html += `<div class="when">${esc(fmtReset(week.resets_at))}</div>`;
  if (u.error) html += `<div class="when bad">${esc(u.error)}</div>`;
  if (!html) html = '<div class="when">Utilisation : en attente…</div>';
  box.innerHTML = html;
  renderMoment(u.moment);
}

function renderMoment(m) {
  const box = $('#moment');
  if (!m || m.level === 'unknown') { box.innerHTML = ''; box.className = 'moment'; return; }
  const icon = { good: '🟢', medium: '🟠', bad: '🔴' }[m.level] || '';
  box.className = `moment ${m.level}`;
  box.innerHTML = `<div class="title">${icon} ${esc(m.title)}</div><ul>${(m.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
}

// ---------- Conversations ----------
async function loadConvs() {
  state.convs = await api('GET', '/api/conversations');
  renderConvList();
}

function renderConvList() {
  const ul = $('#convList');
  ul.innerHTML = '';
  for (const c of state.convs) {
    const li = document.createElement('li');
    li.className = (c.id === state.current?.id ? 'active ' : '') + (c.status === 'running' ? 'running' : '');
    li.innerHTML = '<span class="dot"></span><span class="name"></span>';
    li.querySelector('.name').textContent = c.title;
    li.title = c.cwd;
    li.addEventListener('click', () => { openConv(c.id); document.body.classList.remove('side-open'); });
    ul.appendChild(li);
  }
}

function renderEmpty() {
  state.current = null;
  $('#convTitle').textContent = 'Aucune conversation';
  $('#convStatus').textContent = '';
  $('#messages').innerHTML = '<div class="meta">Crée une conversation pour commencer.</div>';
}

async function openConv(id) {
  const conv = await api('GET', `/api/conversations/${id}`);
  state.current = conv;
  state.live = '';
  state.activity = '';
  localStorage.setItem('relay.last', id);
  $('#convTitle').textContent = conv.title;
  $('#convTitle').title = conv.cwd;
  $('#modelSel').value = conv.model || '';
  $('#effortSel').value = conv.effort || '';
  $('#confSel').value = conv.confinement || '';
  const box = $('#messages');
  box.innerHTML = '';
  for (const m of conv.messages) box.appendChild(renderMessage(m));
  renderStatus();
  renderConvList();
  scrollBottom(true);
  $('#input').focus();
}

function renderStatus() {
  const c = state.current;
  if (!c) return;
  const el = $('#convStatus');
  const running = c.status === 'running';
  el.className = 'status' + (running ? ' running' : '');
  el.textContent = running ? (c.queue ? `en cours · ${c.queue} en attente` : 'en cours…') : '';
  $('#stopBtn').hidden = !running;
}

function updateConvLocal(id, patch) {
  const c = state.convs.find((x) => x.id === id);
  if (c) Object.assign(c, patch);
  if (state.current?.id === id) Object.assign(state.current, patch);
}

// ---------- Événements temps réel ----------
function handleEvent(ev) {
  if (ev.type === 'usage') { renderUsage(ev); return; }
  if (ev.type === 'settings') { state.cfg = { ...state.cfg, ...ev }; renderClaudeStatus(); renderVersion(state.cfg.update); armIdleTimer(); return; }
  if (ev.type === 'update') { renderVersion(ev); if ($('#settingsDialog').open) renderUpdate(ev); return; }
  if (ev.type === 'conv') {
    if (ev.action === 'deleted') {
      state.convs = state.convs.filter((c) => c.id !== ev.id);
      if (state.current?.id === ev.id) renderEmpty();
    } else {
      const i = state.convs.findIndex((c) => c.id === ev.conv.id);
      if (i >= 0) state.convs[i] = { ...state.convs[i], ...ev.conv }; else state.convs.unshift(ev.conv);
      if (state.current?.id === ev.conv.id) {
        Object.assign(state.current, ev.conv);
        $('#convTitle').textContent = ev.conv.title;
        $('#modelSel').value = ev.conv.model || '';
        $('#effortSel').value = ev.conv.effort || '';
        $('#confSel').value = ev.conv.confinement || '';
      }
    }
    state.convs.sort((a, b) => b.updatedAt - a.updatedAt);
    renderConvList();
    return;
  }
  const mine = ev.conv === state.current?.id;
  switch (ev.type) {
    case 'status':
      updateConvLocal(ev.conv, { status: ev.status, queue: ev.status === 'idle' ? 0 : state.current?.queue });
      if (mine) { if (ev.status === 'idle') { state.live = ''; state.activity = ''; renderLive(); } renderStatus(); }
      renderConvList();
      break;
    case 'queued':
      updateConvLocal(ev.conv, { queue: ev.size });
      if (mine) renderStatus();
      break;
    case 'delta':
      if (mine) { state.live += ev.text; state.activity = ''; renderLive(); }
      break;
    case 'tool_start':
      if (mine) { state.activity = `🔧 ${ev.name}…`; renderLive(); }
      break;
    case 'message':
      updateConvLocal(ev.conv, { updatedAt: Date.now() });
      if (mine) {
        if (ev.message.role === 'assistant') state.live = '';
        if (!document.getElementById('m-' + ev.message.id)) {
          removeLive();
          $('#messages').appendChild(renderMessage(ev.message));
          renderLive();
        }
        scrollBottom();
      }
      break;
    default:
      break;
  }
}

// ---------- Rendu ----------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function md(src) {
  const lines = src.split('\n');
  let out = '';
  let i = 0;
  const isList = (l) => /^\s*[-*•]\s+/.test(l);
  const isOl = (l) => /^\s*\d+[.)]\s+/.test(l);
  const isHead = (l) => /^#{1,6}\s/.test(l);
  const isFence = (l) => /^\s*```/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (isFence(l)) {
      const lang = l.trim().slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
      i++;
      out += `<pre><code class="lang-${esc(lang)}">${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    if (isHead(l)) {
      const m = l.match(/^(#{1,6})\s+(.*)/);
      out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
      i++;
      continue;
    }
    if (isList(l)) {
      out += '<ul>';
      while (i < lines.length && isList(lines[i])) out += `<li>${inline(lines[i++].replace(/^\s*[-*•]\s+/, ''))}</li>`;
      out += '</ul>';
      continue;
    }
    if (isOl(l)) {
      out += '<ol>';
      while (i < lines.length && isOl(lines[i])) out += `<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))}</li>`;
      out += '</ol>';
      continue;
    }
    if (/^\s*$/.test(l)) { i++; continue; }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isFence(lines[i]) && !isHead(lines[i]) && !isList(lines[i]) && !isOl(lines[i])) buf.push(lines[i++]);
    out += `<p>${inline(buf.join('\n'))}</p>`;
  }
  return out;

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\n/g, '<br>');
  }
}

function toolSummary(b) {
  const inp = b.input || {};
  const first = (v) => String(v ?? '').split('\n')[0].slice(0, 140);
  if (inp.command) return first(inp.command);
  if (inp.description) return first(inp.description);
  if (inp.file_path) return first(inp.file_path);
  if (inp.pattern) return first(inp.pattern);
  if (inp.url) return first(inp.url);
  if (inp.query) return first(inp.query);
  return first(JSON.stringify(inp));
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function renderMessage(m) {
  let node;
  switch (m.role) {
    case 'user': {
      node = el('div', 'msg user');
      const d = el('div');
      d.textContent = m.text;
      if (m.attachments?.length) {
        const wrap = el('div', 'attachments');
        for (const a of m.attachments) {
          const href = `/api/conversations/${state.current?.id}/file?path=${encodeURIComponent(a.path)}`;
          if (a.kind === 'image') {
            const link = el('a', 'thumb'); link.href = href; link.target = '_blank'; link.rel = 'noopener';
            const img = el('img'); img.src = href; img.alt = a.name; img.loading = 'lazy';
            link.appendChild(img); wrap.appendChild(link);
          } else {
            const chip = el('span', 'chip', '📄 '); const nm = el('span'); nm.textContent = a.rel || a.name; chip.appendChild(nm); chip.title = a.path; wrap.appendChild(chip);
          }
        }
        d.appendChild(wrap);
      }
      node.appendChild(d);
      break;
    }
    case 'assistant': {
      node = el('div');
      node.style.display = 'contents';
      for (const b of m.blocks || []) {
        if (b.type === 'text') {
          const wrap = el('div', 'msg assistant');
          wrap.appendChild(el('div', '', md(b.text)));
          node.appendChild(wrap);
        } else if (b.type === 'tool_use') {
          const t = el('div', 'tool');
          t.innerHTML = `<details><summary>🔧 <b>${esc(b.name)}</b> · ${esc(toolSummary(b))}</summary><pre>${esc(JSON.stringify(b.input, null, 2))}</pre></details>`;
          node.appendChild(t);
        }
      }
      break;
    }
    case 'tool_result': {
      node = el('div', 'tool-result' + (m.isError ? ' error' : ''));
      const len = (m.text || '').length;
      node.innerHTML = `<details${m.isError ? ' open' : ''}><summary>↳ ${m.isError ? 'erreur' : 'résultat'} (${len} car.)</summary><pre>${esc(m.text || '')}</pre></details>`;
      break;
    }
    case 'result': {
      if (m.isError) { node = el('div', m.text ? 'err' : 'meta'); node.textContent = m.text || '✗ échec'; }
      else if (m.stopped) node = el('div', 'meta', '■ arrêté');
      else {
        const s = Math.round((m.durationMs || 0) / 1000);
        const dur = s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
        node = el('div', 'meta ok', `✓ ${dur}${m.numTurns ? ` · ${m.numTurns} tour${m.numTurns > 1 ? 's' : ''}` : ''}`);
      }
      break;
    }
    case 'error': {
      node = el('div', 'err');
      node.textContent = m.text;
      break;
    }
    default:
      node = el('div', 'meta', esc(m.role));
  }
  node.id = 'm-' + m.id;
  return node;
}

function removeLive() {
  document.getElementById('live')?.remove();
  document.getElementById('activity')?.remove();
}

function renderLive() {
  removeLive();
  const box = $('#messages');
  if (state.live) {
    const wrap = el('div', 'msg assistant live');
    wrap.id = 'live';
    wrap.appendChild(el('div', '', md(state.live)));
    box.appendChild(wrap);
  }
  if (state.activity) {
    const a = el('div', 'activity');
    a.id = 'activity';
    a.textContent = state.activity;
    box.appendChild(a);
  }
  scrollBottom();
}

function scrollBottom(force = false) {
  const box = $('#messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (force || near) box.scrollTop = box.scrollHeight;
}

function localError(text) {
  const d = el('div', 'err local');
  d.textContent = text;
  $('#messages').appendChild(d);
  scrollBottom(true);
}

// ---------- Pièces jointes ----------
const pending = []; // { file, rel, kind, preview }
const IMAGE_RE = /^image\/(png|jpeg|gif|webp)$/;

function renderPending() {
  const box = $('#pending');
  box.innerHTML = '';
  box.hidden = pending.length === 0;
  pending.forEach((p, i) => {
    const chip = el('span', 'chip');
    if (p.preview) { const img = el('img'); img.src = p.preview; chip.appendChild(img); }
    else chip.appendChild(document.createTextNode(p.kind === 'image' ? '🖼 ' : '📄 '));
    const nm = el('span'); nm.textContent = p.rel; chip.appendChild(nm);
    const x = el('button', '', '×'); x.type = 'button'; x.title = 'Retirer';
    x.addEventListener('click', () => { pending.splice(i, 1); renderPending(); });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

function addFiles(fileList, { relative = false } = {}) {
  for (const file of fileList) {
    if (!file || file.size === 0 && !file.type) continue;
    const rel = (relative && file.webkitRelativePath) ? file.webkitRelativePath : (file.name || `image-${Date.now()}.png`);
    if (rel.split('/').some((seg) => seg === 'node_modules' || seg === '.git' || seg.startsWith('.DS_'))) continue;
    const kind = IMAGE_RE.test(file.type) ? 'image' : 'file';
    const p = { file, rel, kind, preview: null };
    if (kind === 'image') { p.preview = URL.createObjectURL(file); }
    pending.push(p);
  }
  renderPending();
}

/** Réduit une image trop grande (côté ≤ 1600 px) pour rester légère à transmettre. */
async function shrinkImage(file) {
  if (!IMAGE_RE.test(file.type) || file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const max = 1600;
  if (bmp.width <= max && bmp.height <= max && file.size < 3 * 1024 * 1024) { bmp.close(); return file; }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return blob ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
}

async function uploadPending(convId) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
  const done = [];
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    $('#uploadStatus').textContent = `Envoi ${i + 1}/${pending.length} : ${p.rel}`;
    const file = p.kind === 'image' ? await shrinkImage(p.file) : p.file;
    const rel = p.kind === 'image' && file !== p.file ? p.rel.replace(/\.[^.]+$/, '') + '.jpg' : p.rel;
    const r = await fetch(`/api/conversations/${convId}/files?batch=${stamp}&path=${encodeURIComponent(rel)}`, {
      method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: file,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p.rel} : ${data.error || r.statusText}`);
    done.push(data);
  }
  $('#uploadStatus').textContent = '';
  return done;
}

$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#attachDirBtn').addEventListener('click', () => $('#dirInput').click());
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#dirInput').addEventListener('change', (e) => { addFiles(e.target.files, { relative: true }); e.target.value = ''; });
$('#input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
for (const ev of ['dragenter', 'dragover']) $('#composer').addEventListener(ev, (e) => { e.preventDefault(); $('#composer').classList.add('dragover'); });
for (const ev of ['dragleave', 'drop']) $('#composer').addEventListener(ev, (e) => { e.preventDefault(); $('#composer').classList.remove('dragover'); });
$('#composer').addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

// ---------- Composer ----------
async function sendCurrent() {
  const ta = $('#input');
  const text = ta.value.trim();
  if ((!text && !pending.length) || !state.current) return;
  ta.value = '';
  const kept = pending.splice(0, pending.length);
  renderPending();
  try {
    let attachments = [];
    if (kept.length) {
      pending.push(...kept); renderPending();
      attachments = await uploadPending(state.current.id);
      for (const p of kept) if (p.preview) URL.revokeObjectURL(p.preview);
      pending.splice(0, pending.length); renderPending();
    }
    const r = await api('POST', `/api/conversations/${state.current.id}/send`, { text, attachments });
    if (!document.getElementById('m-' + r.message.id)) {
      removeLive();
      $('#messages').appendChild(renderMessage(r.message));
      renderLive();
    }
    scrollBottom(true);
  } catch (err) {
    ta.value = text;
    if (!pending.length) { pending.push(...kept); renderPending(); }
    $('#uploadStatus').textContent = '';
    if (err.status === 429) { localError(err.message); refreshUsage(); } else alert(err.message);
  }
}
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendCurrent(); });
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCurrent(); }
});
$('#stopBtn').addEventListener('click', () => {
  if (state.current) api('POST', `/api/conversations/${state.current.id}/stop`).catch((e) => alert(e.message));
});

// ---------- Modèle / effort de la conversation ----------
for (const [sel, key] of [['#modelSel', 'model'], ['#effortSel', 'effort'], ['#confSel', 'confinement']]) {
  $(sel).addEventListener('change', async (e) => {
    if (!state.current) return;
    try { await api('PATCH', `/api/conversations/${state.current.id}`, { [key]: e.target.value }); } catch (err) { alert(err.message); }
  });
}

// ---------- Nouvelle / renommer / supprimer ----------
$('#newConv').addEventListener('click', () => {
  $('#newTitle').value = '';
  $('#newCwd').value = state.current?.cwd || state.cfg?.defaultCwd || '';
  $('#newModel').value = state.current?.model || '';
  $('#newEffort').value = state.current?.effort || '';
  $('#newConf').value = state.current?.confinement || '';
  $('#newDialog').showModal();
  $('#newTitle').focus();
});
$('#newCancel').addEventListener('click', () => $('#newDialog').close());
$('#newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const conv = await api('POST', '/api/conversations', {
      title: $('#newTitle').value, cwd: $('#newCwd').value, model: $('#newModel').value, effort: $('#newEffort').value,
      confinement: $('#newConf').value,
    });
    $('#newDialog').close();
    if (!state.convs.some((c) => c.id === conv.id)) state.convs.unshift(conv);
    await openConv(conv.id);
  } catch (err) {
    alert(err.message);
  }
});
$('#renameBtn').addEventListener('click', async () => {
  if (!state.current) return;
  const title = prompt('Nouveau titre', state.current.title);
  if (!title?.trim()) return;
  try { await api('PATCH', `/api/conversations/${state.current.id}`, { title: title.trim() }); } catch (err) { alert(err.message); }
});
$('#deleteBtn').addEventListener('click', async () => {
  if (!state.current) return;
  if (!confirm(`Supprimer « ${state.current.title} » ?`)) return;
  try {
    await api('DELETE', `/api/conversations/${state.current.id}`);
    state.convs = state.convs.filter((c) => c.id !== state.current.id);
    renderConvList();
    if (state.convs[0]) openConv(state.convs[0].id); else renderEmpty();
  } catch (err) { alert(err.message); }
});
$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('side-open'));

// ---------- Réglages ----------
$('#settingsBtn').addEventListener('click', () => {
  const c = state.cfg;
  $('#setModel').value = MODELS.some(([v]) => v === c.model) ? c.model : '';
  $('#setEffort').value = c.effort || '';
  $('#setPermission').value = c.permissionMode;
  $('#setConf').value = c.confinement || 'none';
  $('#confHint').textContent = CONF_HELP[$('#setConf').value] || '';
  $('#setCwd').value = c.defaultCwd || '';
  const p = c.policy || {};
  $('#setSessionLocal').value = p.sessionLocalLimitPercent ?? 0;
  $('#setWeeklyLocal').value = p.weeklyLocalLimitPercent ?? 0;
  $('#setSessionReserve').value = p.sessionReservePercent ?? 0;
  $('#setWeeklyReserve').value = p.weeklyReservePercent ?? 0;
  $('#setSessionRelease').value = p.sessionReleaseHours ?? 2;
  $('#setWeeklyRelease').value = p.weeklyReleaseDays ?? 2;
  const locked = Boolean(c.adminPublicKey);
  $('#barrierFields').disabled = locked;
  $('#resetLocalBtn').disabled = locked;
  $('#lockBadge').hidden = !locked;
  $('#policyInfo').textContent = !locked ? ''
    : p.valid ? `Politique signée le ${new Date(p.issuedAt).toLocaleString('fr-FR')}${p.note ? ' — ' + p.note : ''}. Pour la changer : générer une nouvelle politique sur le poste administrateur et la coller ci-dessous.`
    : `Aucune politique valide (${p.error}) : valeurs strictes par défaut appliquées. Colle une politique signée ci-dessous.`;
  const up = c.update || {};
  $('#setUpdateRepo').value = up.repo || '';
  $('#setUpdateBranch').value = up.branch || 'main';
  $('#setUpdateToken').value = up.hasToken ? '••••' : '';
  renderUpdate(up);
  $('#setAdminKey').value = c.adminPublicKey || '';
  $('#setAdminKey').readOnly = locked;
  $('#policyPaste').value = '';
  $('#lockSection').open = locked && !p.valid;
  $('#adminPubKey').value = '';
  $('#adminSigned').value = '';
  $('#setLockAfter').value = c.lockAfterMinutes ?? 5;
  $('#setLockOnHide').checked = Boolean(c.lockOnHide);
  $('#settingsDialog').showModal();
});
$('#settingsCancel').addEventListener('click', () => $('#settingsDialog').close());
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('PATCH', '/api/settings', {
      model: $('#setModel').value,
      effort: $('#setEffort').value,
      permissionMode: $('#setPermission').value,
      confinement: $('#setConf').value,
      defaultCwd: $('#setCwd').value,
      updateRepo: $('#setUpdateRepo').value,
      updateBranch: $('#setUpdateBranch').value || 'main',
      updateToken: $('#setUpdateToken').value,
      ...(state.cfg.adminPublicKey ? {} : barrierValues()),
      ...(state.cfg.adminPublicKey || !$('#setAdminKey').value.trim() ? {} : { adminPublicKey: $('#setAdminKey').value.trim() }),
      lockAfterMinutes: Number($('#setLockAfter').value),
      lockOnHide: $('#setLockOnHide').checked,
    });
    state.cfg = { ...state.cfg, ...r };
    renderClaudeStatus();
    armIdleTimer();
    $('#settingsDialog').close();
    refreshUsage();
  } catch (err) {
    alert(err.message);
  }
});

function barrierValues() {
  return {
    sessionLocalLimitPercent: Number($('#setSessionLocal').value),
    weeklyLocalLimitPercent: Number($('#setWeeklyLocal').value),
    sessionReservePercent: Number($('#setSessionReserve').value),
    weeklyReservePercent: Number($('#setWeeklyReserve').value),
    sessionReleaseHours: Number($('#setSessionRelease').value),
    weeklyReleaseDays: Number($('#setWeeklyRelease').value),
  };
}
async function saveUpdateSource() {
  const r = await api('PATCH', '/api/settings', {
    updateRepo: $('#setUpdateRepo').value, updateBranch: $('#setUpdateBranch').value || 'main', updateToken: $('#setUpdateToken').value,
  });
  state.cfg = { ...state.cfg, ...r };
}
$('#updateCheck').addEventListener('click', async () => {
  $('#updateInfo').textContent = 'Vérification…';
  try { await saveUpdateSource(); renderUpdate(await api('POST', '/api/update/check')); } catch (e) { $('#updateInfo').textContent = e.message; }
});
$('#updateApply').addEventListener('click', async () => {
  if (!confirm('Télécharger et installer la nouvelle version, puis redémarrer le serveur ?')) return;
  $('#updateApply').disabled = true;
  $('#updateInfo').textContent = 'Téléchargement et installation…';
  try {
    const r = await api('POST', '/api/update/apply');
    $('#updateInfo').textContent = `Installé (${(r.current?.sha || '').slice(0, 7)}). Redémarrage du serveur, la page se rechargera toute seule…`;
    // On attend que le serveur revienne, puis on recharge.
    const t0 = Date.now();
    const poll = async () => {
      try { const m = await fetch('/api/me', { cache: 'no-store' }); if (m.status === 200 || m.status === 401) { location.reload(); return; } } catch { /* pas encore revenu */ }
      if (Date.now() - t0 < 90_000) setTimeout(poll, 2000); else $('#updateInfo').textContent += ' Le serveur ne répond pas encore : relance-le puis recharge la page.';
    };
    setTimeout(poll, 3000);
  } catch (e) {
    $('#updateInfo').textContent = e.message;
    $('#updateApply').disabled = false;
  }
});
async function waitForServerThenReload(t0 = Date.now()) {
  try { const m = await fetch('/api/me', { cache: 'no-store' }); if (m.status === 200 || m.status === 401) { location.reload(); return; } } catch { /* pas encore revenu */ }
  if (Date.now() - t0 < 90_000) setTimeout(() => waitForServerThenReload(t0), 2000);
  else $('#updateInfo').textContent += ' Le serveur ne répond pas encore : relance-le puis recharge la page.';
}
$('#updateRestart').addEventListener('click', async () => {
  if (!confirm('Redémarrer le serveur maintenant ?')) return;
  $('#updateRestart').disabled = true;
  try {
    await api('POST', '/api/update/restart');
    $('#updateInfo').textContent = 'Redémarrage du serveur, la page se rechargera toute seule…';
    setTimeout(() => waitForServerThenReload(), 3000);
  } catch (e) { $('#updateInfo').textContent = e.message; $('#updateRestart').disabled = false; }
});
$('#policyApply').addEventListener('click', async () => {
  const signed = $('#policyPaste').value.trim();
  if (!signed) return;
  try {
    if (!state.cfg.adminPublicKey && $('#setAdminKey').value.trim()) {
      const r = await api('PATCH', '/api/settings', { adminPublicKey: $('#setAdminKey').value.trim() });
      state.cfg = { ...state.cfg, ...r };
    }
    const r = await api('POST', '/api/policy', { signed });
    state.cfg = { ...state.cfg, ...r };
    $('#settingsDialog').close();
    refreshUsage(true);
    alert('Politique appliquée.');
  } catch (e) { alert(e.message); }
});
$('#adminCreateKey').addEventListener('click', async () => {
  try { const r = await api('POST', '/api/admin/key'); $('#adminPubKey').value = r.publicKey; state.cfg.hasAdminKey = true; } catch (e) { alert(e.message); }
});
$('#adminSign').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/admin/sign', { ...barrierValues(), note: $('#adminNote').value });
    $('#adminSigned').value = r.signed;
    $('#adminSigned').select();
  } catch (e) { alert(e.message); }
});
$('#resetLocalBtn').addEventListener('click', async () => {
  if (!confirm('Remettre à zéro le compteur de consommation de ce poste ?')) return;
  try { renderUsage(await api('POST', '/api/usage/reset')); } catch (e) { alert(e.message); }
});
$('#setConf').addEventListener('change', (e) => { $('#confHint').textContent = CONF_HELP[e.target.value] || ''; });

// ---------- Explorateur de dossiers ----------
const pick = { target: null, path: null };

async function pickLoad(dir) {
  const q = dir ? `?path=${encodeURIComponent(dir)}` : '';
  const r = await api('GET', `/api/fs${q}`);
  pick.path = r.path;
  $('#pickPath').textContent = r.path;
  $('#pickMsg').textContent = '';
  const ul = $('#pickList');
  ul.innerHTML = '';
  if (r.parent) {
    const up = el('li', 'up', '↑ Dossier parent');
    up.addEventListener('click', () => pickLoad(r.parent).catch((e) => { $('#pickMsg').textContent = e.message; }));
    ul.appendChild(up);
  }
  if (!r.dirs.length) ul.appendChild(el('li', 'empty', 'Aucun sous-dossier'));
  for (const name of r.dirs) {
    const li = el('li', '', '📁 ');
    li.appendChild(document.createTextNode(name));
    li.addEventListener('click', () => pickLoad(r.path + r.sep + name).catch((e) => { $('#pickMsg').textContent = e.message; }));
    ul.appendChild(li);
  }
}

for (const btn of document.querySelectorAll('button.pick')) {
  btn.addEventListener('click', async () => {
    pick.target = document.getElementById(btn.dataset.target);
    $('#pickNewName').value = '';
    $('#pickDialog').showModal();
    try { await pickLoad(pick.target.value.trim() || state.cfg.defaultCwd); }
    catch { try { await pickLoad(state.cfg.browseRoot); } catch (e) { $('#pickMsg').textContent = e.message; } }
  });
}
$('#pickCancel').addEventListener('click', () => $('#pickDialog').close());
$('#pickNewBtn').addEventListener('click', async () => {
  const name = $('#pickNewName').value.trim();
  if (!name || !pick.path) return;
  try {
    const r = await api('POST', '/api/fs/mkdir', { path: pick.path, name });
    $('#pickNewName').value = '';
    await pickLoad(r.path);
    $('#pickMsg').textContent = 'Dossier créé.';
  } catch (e) { $('#pickMsg').textContent = e.message; }
});
$('#pickNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#pickNewBtn').click(); } });
$('#pickForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (pick.target && pick.path) pick.target.value = pick.path;
  $('#pickDialog').close();
});

// ---------- Démarrage ----------
(async () => {
  try { await init(); } catch { showLock(); }
})();
