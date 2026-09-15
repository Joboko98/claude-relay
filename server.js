import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, DATA_DIR, loadConfig, saveConfig } from './lib/config.js';
import { Auth } from './lib/auth.js';
import { Store } from './lib/store.js';
import { Hub } from './lib/sse.js';
import { Runner, findClaude } from './lib/claude.js';
import { Usage } from './lib/usage.js';
import { AdminKey, POLICY_FIELDS, effectivePolicy, validatePolicy, verifySigned } from './lib/policy.js';
import { Updater } from './lib/update.js';

const config = loadConfig();
if (!config.pinHash) {
  console.error('Aucun code PIN configuré. Lance d\'abord :  npm run setup');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const auth = new Auth({ dataDir: DATA_DIR, config });
const store = new Store({ dataDir: DATA_DIR });
const hub = new Hub();
const usage = new Usage({ hub, config, dataDir: DATA_DIR });
const runner = new Runner({ store, hub, config, usage });
const adminKey = new AdminKey(DATA_DIR);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const updater = new Updater({ config, rootDir: ROOT, dataDir: DATA_DIR, pkg });

const PUBLIC = path.join(ROOT, 'public');
const COOKIE = 'relay_sid';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const CONFINEMENTS = ['none', 'sandbox', 'restricted'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[a-z0-9._-]{0,60}$/i;

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error('Corps trop volumineux')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

function cookieHeader(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function publicConfig() {
  const claudePath = findClaude(config.claudePath);
  return {
    claudeFound: Boolean(claudePath),
    claudePath,
    platform: process.platform,
    permissionMode: config.permissionMode,
    confinement: config.confinement,
    browseRoot: config.browseRoot,
    model: config.model,
    effort: config.effort,
    lockOnHide: config.lockOnHide,
    lockAfterMinutes: config.lockAfterMinutes,
    defaultCwd: config.defaultCwd,
    policy: effectivePolicy(config),
    adminPublicKey: config.adminPublicKey || '',
    hasAdminKey: adminKey.exists(),
    update: updater.status(),
  };
}

function validModel(v) {
  const s = String(v ?? '').trim();
  return MODEL_RE.test(s) ? s : null;
}
function validEffort(v) {
  const s = String(v ?? '').trim();
  return EFFORTS.includes(s) ? s : null;
}
function validConfinement(v, { allowEmpty = false } = {}) {
  const s = String(v ?? '').trim();
  if (allowEmpty && s === '') return '';
  if (!CONFINEMENTS.includes(s)) return null;
  if (s === 'sandbox' && process.platform === 'win32') return null;
  return s;
}
/** Chemin absolu normalisé, obligatoirement sous browseRoot. */
function safeDir(p) {
  const root = path.resolve(config.browseRoot || process.env.HOME || '/');
  const abs = path.resolve(String(p || root));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}
function validPercent(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

async function api(req, res, url) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE];
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const r = auth.login(String(body.pin ?? ''));
    if (!r.ok) return json(res, 401, { error: 'Code incorrect', retryInMs: r.retryInMs });
    res.setHeader('Set-Cookie', cookieHeader(r.token, config.sessionDays * 86400));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/logout' && method === 'POST') {
    auth.logout(token);
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    return json(res, 200, { ok: true });
  }

  if (!auth.check(token)) return json(res, 401, { error: 'Non authentifié' });
  // Anti-CSRF : SameSite=Strict + en-tête custom obligatoire sur les écritures.
  if (method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') {
    return json(res, 403, { error: 'Requête refusée' });
  }

  if (p === '/api/me' && method === 'GET') return json(res, 200, { ok: true, ...publicConfig() });

  if (p === '/api/events' && method === 'GET') return hub.add(res);

  if (p === '/api/usage' && method === 'GET') {
    return json(res, 200, await usage.refresh({ force: url.searchParams.has('force') }));
  }

  if (p === '/api/usage/reset' && method === 'POST') {
    if (config.adminPublicKey) return json(res, 403, { error: 'Compteur verrouillé par l\'administrateur.' });
    usage.resetLocal();
    return json(res, 200, { ok: true, ...usage.snapshot() });
  }

  // --- Mise à jour depuis GitHub ---
  if (p === '/api/update' && method === 'GET') return json(res, 200, updater.status());
  if (p === '/api/update/check' && method === 'POST') return json(res, 200, await updater.check());
  if (p === '/api/update/restart' && method === 'POST') {
    const running = store.list().filter((c) => runner.isRunning(c.id)).length;
    if (running) return json(res, 409, { error: `${running} tâche(s) en cours : attends qu'elles se terminent (ou arrête-les) avant de redémarrer.` });
    json(res, 200, { ok: true, restarting: true });
    console.log('Redémarrage demandé depuis l\'interface…');
    updater.scheduleRestart();
    return undefined;
  }
  if (p === '/api/update/apply' && method === 'POST') {
    const running = store.list().filter((c) => runner.isRunning(c.id)).length;
    if (running) return json(res, 409, { error: `${running} tâche(s) en cours : attends qu'elles se terminent (ou arrête-les) avant de mettre à jour.` });
    try {
      const st = await updater.apply();
      json(res, 200, { ok: true, ...st, restarting: true });
      console.log(`Mise à jour installée (${st.current.sha?.slice(0, 7)}), redémarrage…`);
      updater.scheduleRestart();
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return undefined;
  }

  // --- Politique signée (poste administré) ---
  if (p === '/api/policy' && method === 'POST') {
    const body = await readBody(req);
    if (!config.adminPublicKey) return json(res, 400, { error: 'Pose d\'abord la clé publique de l\'administrateur dans les réglages.' });
    const v = verifySigned(body.signed, config.adminPublicKey);
    if (v.error) return json(res, 400, { error: v.error });
    const current = effectivePolicy(config);
    if (current.valid && current.issuedAt && v.issuedAt <= current.issuedAt) {
      return json(res, 400, { error: 'Cette politique est plus ancienne que celle en vigueur : refusée.' });
    }
    config.signedPolicy = String(body.signed).trim();
    saveConfig(config);
    const pub = publicConfig();
    hub.broadcast({ type: 'settings', ...pub });
    hub.broadcast({ type: 'usage', ...usage.snapshot() });
    return json(res, 200, { ok: true, ...pub });
  }

  // --- Administration (poste maison) ---
  if (p === '/api/admin' && method === 'GET') {
    return json(res, 200, { publicKey: adminKey.publicKey(), fields: POLICY_FIELDS });
  }
  if (p === '/api/admin/key' && method === 'POST') {
    return json(res, 200, { publicKey: adminKey.create() });
  }
  if (p === '/api/admin/sign' && method === 'POST') {
    const body = await readBody(req);
    if (!adminKey.exists()) return json(res, 400, { error: 'Crée d\'abord la clé d\'administration.' });
    const v = validatePolicy(body);
    if (v.error) return json(res, 400, { error: v.error });
    return json(res, 200, { signed: adminKey.sign(v.policy, body.note), policy: v.policy });
  }

  if (p === '/api/settings' && method === 'PATCH') {
    const body = await readBody(req);
    const errors = [];
    if ('permissionMode' in body) {
      if (PERMISSION_MODES.includes(body.permissionMode)) config.permissionMode = body.permissionMode; else errors.push('permissionMode');
    }
    if ('model' in body) { const v = validModel(body.model); if (v !== null) config.model = v; else errors.push('model'); }
    if ('effort' in body) { const v = validEffort(body.effort); if (v !== null) config.effort = v; else errors.push('effort'); }
    if ('confinement' in body) { const v = validConfinement(body.confinement); if (v !== null) config.confinement = v; else errors.push('confinement'); }
    if ('lockOnHide' in body) config.lockOnHide = Boolean(body.lockOnHide);
    if ('lockAfterMinutes' in body) {
      const n = Number(body.lockAfterMinutes);
      if (Number.isInteger(n) && n >= 0 && n <= 1440) config.lockAfterMinutes = n; else errors.push('lockAfterMinutes');
    }
    const barrierKeys = Object.keys(POLICY_FIELDS);
    if (barrierKeys.some((k) => k in body)) {
      if (config.adminPublicKey) return json(res, 403, { error: 'Barrières verrouillées par l\'administrateur : elles ne changent que par politique signée depuis le poste administrateur.' });
      const v = validatePolicy({ ...config, ...Object.fromEntries(barrierKeys.filter((k) => k in body).map((k) => [k, body[k]])) });
      if (v.error) return json(res, 400, { error: v.error });
      Object.assign(config, v.policy);
    }
    if ('updateRepo' in body) {
      const v = String(body.updateRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      if (v && !/^[\w.-]+\/[\w.-]+$/.test(v)) errors.push('updateRepo'); else config.updateRepo = v;
    }
    if ('updateBranch' in body) {
      const v = String(body.updateBranch || 'main').trim();
      if (!/^[\w./-]{1,100}$/.test(v)) errors.push('updateBranch'); else config.updateBranch = v;
    }
    if ('updateToken' in body) {
      const v = String(body.updateToken || '').trim();
      if (v !== '••••') config.updateToken = v; // « •••• » = inchangé
    }
    if ('adminPublicKey' in body) {
      const k = String(body.adminPublicKey || '').trim();
      if (config.adminPublicKey) return json(res, 403, { error: 'La clé de l\'administrateur est déjà posée : pour la retirer, édite config.json sur ce poste.' });
      if (k) {
        const probe = verifySigned('x.y', k);
        if (/illisible/.test(probe.error || '')) return json(res, 400, { error: 'Clé publique invalide' });
        config.adminPublicKey = k;
      }
    }
    if ('defaultCwd' in body) {
      const d = String(body.defaultCwd || '').trim();
      if (d && fs.existsSync(d) && fs.statSync(d).isDirectory()) config.defaultCwd = d; else errors.push('defaultCwd');
    }
    if (errors.length) return json(res, 400, { error: `Valeur invalide : ${errors.join(', ')}` });
    saveConfig(config);
    const pub = publicConfig();
    hub.broadcast({ type: 'settings', ...pub });
    hub.broadcast({ type: 'usage', ...usage.snapshot() });
    return json(res, 200, { ok: true, ...pub });
  }

  if (p === '/api/fs' && method === 'GET') {
    const dir = safeDir(url.searchParams.get('path'));
    if (!dir) return json(res, 400, { error: 'Dossier hors de la zone autorisée' });
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return json(res, 400, { error: `Impossible d'ouvrir : ${err.message}` }); }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))
      .slice(0, 500);
    const root = path.resolve(config.browseRoot);
    const parent = dir === root ? null : path.dirname(dir);
    return json(res, 200, { path: dir, parent, root, dirs, sep: path.sep });
  }

  if (p === '/api/fs/mkdir' && method === 'POST') {
    const body = await readBody(req);
    const parent = safeDir(body.path);
    const name = String(body.name || '').trim();
    if (!parent) return json(res, 400, { error: 'Dossier hors de la zone autorisée' });
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return json(res, 400, { error: 'Nom de dossier invalide' });
    const target = path.join(parent, name);
    try { fs.mkdirSync(target, { recursive: false }); } catch (err) {
      if (err.code === 'EEXIST') return json(res, 400, { error: 'Ce dossier existe déjà' });
      return json(res, 400, { error: `Création impossible : ${err.message}` });
    }
    return json(res, 201, { path: target });
  }

  if (p === '/api/conversations' && method === 'GET') {
    return json(res, 200, store.list().map((c) => ({ ...c, queue: runner.queueSize(c.id) })));
  }

  if (p === '/api/conversations' && method === 'POST') {
    const body = await readBody(req);
    const cwd = String(body.cwd || config.defaultCwd).trim();
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return json(res, 400, { error: `Dossier introuvable : ${cwd}` });
    }
    const model = validModel(body.model) ?? '';
    const effort = validEffort(body.effort) ?? '';
    const confinement = validConfinement(body.confinement, { allowEmpty: true }) ?? '';
    const conv = store.create({ title: String(body.title || '').trim().slice(0, 120), cwd, model, effort, confinement });
    hub.broadcast({ type: 'conv', action: 'created', conv });
    return json(res, 201, conv);
  }

  const m = p.match(/^\/api\/conversations\/([0-9a-f-]{36})(?:\/(send|stop|files|file))?$/);
  if (m) {
    const conv = store.get(m[1]);
    if (!conv) return json(res, 404, { error: 'Conversation introuvable' });
    const action = m[2];

    if (!action && method === 'GET') {
      return json(res, 200, { ...conv, queue: runner.queueSize(conv.id), messages: store.messages(conv.id) });
    }
    if (!action && method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if ('title' in body) {
        const title = String(body.title || '').trim().slice(0, 120);
        if (!title) return json(res, 400, { error: 'Titre vide' });
        patch.title = title;
      }
      if ('model' in body) { const v = validModel(body.model); if (v === null) return json(res, 400, { error: 'Modèle invalide' }); patch.model = v; }
      if ('effort' in body) { const v = validEffort(body.effort); if (v === null) return json(res, 400, { error: 'Effort invalide' }); patch.effort = v; }
      if ('confinement' in body) { const v = validConfinement(body.confinement, { allowEmpty: true }); if (v === null) return json(res, 400, { error: 'Confinement invalide (le bac à sable n\'existe pas sur Windows)' }); patch.confinement = v; }
      const updated = store.update(conv.id, patch);
      hub.broadcast({ type: 'conv', action: 'updated', conv: updated });
      return json(res, 200, updated);
    }
    if (!action && method === 'DELETE') {
      runner.stop(conv.id);
      store.remove(conv.id);
      hub.broadcast({ type: 'conv', action: 'deleted', id: conv.id });
      return json(res, 200, { ok: true });
    }
    // Dépôt d'une pièce jointe (corps brut) : <cwd>/_envois/<lot>/<chemin relatif>
    if (action === 'files' && method === 'PUT') {
      const batch = String(url.searchParams.get('batch') || '');
      const rel = String(url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!/^\d{8}-\d{6}$/.test(batch)) return json(res, 400, { error: 'Lot invalide' });
      if (!rel || rel.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return json(res, 400, { error: 'Chemin de fichier invalide' });
      const baseDir = path.join(conv.cwd, '_envois', batch);
      const target = path.resolve(baseDir, ...rel.split('/'));
      if (!target.startsWith(path.resolve(baseDir) + path.sep)) return json(res, 400, { error: 'Chemin de fichier invalide' });
      const chunks = [];
      let size = 0;
      await new Promise((resolve, reject) => {
        req.on('data', (c) => { size += c.length; if (size > 50 * 1024 * 1024) { reject(new Error('Fichier trop volumineux (50 Mo max)')); req.destroy(); } else chunks.push(c); });
        req.on('end', resolve);
        req.on('error', reject);
      }).catch((err) => { json(res, 413, { error: err.message }); return null; });
      if (res.headersSent) return undefined;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.concat(chunks));
      const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
      const kind = /^image\/(png|jpeg|gif|webp)$/.test(mime) ? 'image' : 'file';
      return json(res, 201, { path: target, rel, name: path.basename(rel), kind, mime, size });
    }

    // Lecture d'une pièce jointe (aperçus dans la conversation), limitée au dossier _envois de la conversation
    if (action === 'file' && method === 'GET') {
      const target = path.resolve(String(url.searchParams.get('path') || ''));
      const envois = path.resolve(conv.cwd, '_envois');
      if (!target.startsWith(envois + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404); return res.end();
      }
      const ext = path.extname(target).toLowerCase();
      const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'" });
      return fs.createReadStream(target).pipe(res);
    }

    if (action === 'send' && method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const envois = path.resolve(conv.cwd, '_envois');
      const attachments = [];
      for (const a of Array.isArray(body.attachments) ? body.attachments.slice(0, 200) : []) {
        const ap = path.resolve(String(a.path || ''));
        if (!ap.startsWith(envois + path.sep) || !fs.existsSync(ap)) continue;
        attachments.push({ path: ap, rel: String(a.rel || path.basename(ap)), name: path.basename(ap), kind: a.kind === 'image' ? 'image' : 'file', mime: String(a.mime || ''), size: Number(a.size) || fs.statSync(ap).size });
      }
      if (!text && !attachments.length) return json(res, 400, { error: 'Message vide' });
      const pol = effectivePolicy(config);
      if (pol.sessionLocalLimitPercent > 0 || pol.weeklyLocalLimitPercent > 0 || pol.sessionReservePercent > 0 || pol.weeklyReservePercent > 0) {
        await usage.refresh();
        const why = usage.blocked();
        if (why) return json(res, 429, { error: why });
      }
      if (conv.title === 'Nouvelle conversation') {
        const title = (text || attachments[0]?.name || 'Pièces jointes').split('\n')[0].slice(0, 60);
        store.update(conv.id, { title });
        hub.broadcast({ type: 'conv', action: 'updated', conv: store.get(conv.id) });
      }
      const msg = runner.send(store.get(conv.id), text || (attachments.length ? 'Voici des pièces jointes.' : ''), attachments);
      return json(res, 200, { ok: true, message: msg, queued: runner.queueSize(conv.id) });
    }
    if (action === 'stop' && method === 'POST') {
      return json(res, 200, { ok: runner.stop(conv.id) });
    }
  }

  return json(res, 404, { error: 'Route inconnue' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(config.port, config.host, () => {
  const bin = findClaude(config.claudePath);
  console.log(`claude-relay : http://${config.host}:${config.port}`);
  console.log(`claude       : ${bin || 'INTROUVABLE (installe Claude Code ou renseigne claudePath)'}`);
  console.log(`permissions  : ${config.permissionMode}`);
  usage.refresh().catch(() => {});
  const cur = updater.status().running;
  console.log(`version      : ${cur.version}${cur.sha ? ' · ' + cur.sha.slice(0, 7) : ''}`);
  if (config.updateRepo) {
    const tick = () => updater.check().then((st) => { if (st.available) hub.broadcast({ type: 'update', ...st }); }).catch(() => {});
    setTimeout(tick, 5000).unref();
    setInterval(tick, 6 * 3_600_000).unref();
  }
});

function shutdown() {
  console.log('Arrêt…');
  runner.stopAll();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
