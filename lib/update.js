import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://api.github.com';
const KEEP = new Set(['config.json', 'data', '.git', 'node_modules', 'start-relay.vbs']);

/**
 * Mise à jour depuis un dépôt GitHub : compare le dernier commit de la branche avec la version
 * installée, télécharge l'archive, remplace les fichiers de l'application (jamais config.json,
 * data/ ni la clé d'administration) et redémarre le serveur.
 */
export class Updater {
  constructor({ config, rootDir, dataDir, pkg }) {
    this.config = config;
    this.root = rootDir;
    this.dataDir = dataDir;
    this.pkg = pkg;
    this.file = path.join(dataDir, 'version.json');
    this.running = null;     // version chargée en mémoire au démarrage du processus
    this.latest = null;      // dernier commit vu sur GitHub
    this.checkedAt = 0;
    this.error = null;
    this.busy = false;
  }

  headers() {
    const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-relay-updater', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.config.updateToken) h.Authorization = `Bearer ${this.config.updateToken}`;
    return h;
  }

  /** Version installée : data/version.json (posé par une mise à jour), sinon le dépôt git local, sinon inconnue. */
  current() {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* jamais mis à jour par l'app */ }
    if (!rec) {
      try {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const date = execFileSync('git', ['log', '-1', '--format=%cI', 'HEAD'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const message = execFileSync('git', ['log', '-1', '--format=%s', 'HEAD'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        rec = { sha, date, message, source: 'git' };
      } catch { /* pas de dépôt git */ }
    }
    return { version: this.pkg.version, ...(rec || { sha: null, date: null, message: null, source: 'inconnue' }) };
  }

  status() {
    const cur = this.current();
    if (!this.running) this.running = { ...cur, startedAt: Date.now() };
    const available = Boolean(this.latest && cur.sha && this.latest.sha !== cur.sha) || Boolean(this.latest && !cur.sha);
    // Les fichiers sur le disque sont plus récents que le processus (mise à jour installée, ou commit local) : il faut redémarrer.
    const restartNeeded = Boolean(cur.sha && this.running.sha && cur.sha !== this.running.sha) || cur.version !== this.running.version;
    return {
      running: this.running,
      restartNeeded,
      repo: this.config.updateRepo || '',
      branch: this.config.updateBranch || 'main',
      hasToken: Boolean(this.config.updateToken),
      current: cur,
      latest: this.latest,
      available,
      checkedAt: this.checkedAt,
      error: this.error,
      busy: this.busy,
      autoRestart: Boolean(process.env.RELAY_SERVICE),
      platform: process.platform,
    };
  }

  async check() {
    if (!this.config.updateRepo) { this.error = 'Dépôt GitHub non renseigné (réglages → Mise à jour).'; return this.status(); }
    try {
      const r = await fetch(`${API}/repos/${this.config.updateRepo}/commits/${encodeURIComponent(this.config.updateBranch || 'main')}`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      if (r.status === 404) throw new Error('Dépôt ou branche introuvable (dépôt privé sans jeton ?)');
      if (r.status === 401 || r.status === 403) throw new Error('Jeton GitHub refusé ou expiré');
      if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
      const j = await r.json();
      this.latest = { sha: j.sha, date: j.commit?.committer?.date || j.commit?.author?.date || null, message: (j.commit?.message || '').split('\n')[0] };
      this.checkedAt = Date.now();
      this.error = null;
    } catch (err) {
      this.error = `Vérification impossible : ${err.message}`;
    }
    return this.status();
  }

  /** Télécharge et installe la dernière version. Renvoie le statut ; le redémarrage est à la charge de l'appelant. */
  async apply() {
    if (this.busy) throw new Error('Mise à jour déjà en cours');
    this.busy = true;
    const tmp = path.join(this.dataDir, 'update-tmp');
    try {
      await this.check();
      if (this.error) throw new Error(this.error);
      const sha = this.latest.sha;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const archive = path.join(tmp, 'update.tgz');
      const r = await fetch(`${API}/repos/${this.config.updateRepo}/tarball/${sha}`, { headers: this.headers(), redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`Téléchargement refusé (${r.status})`);
      fs.writeFileSync(archive, Buffer.from(await r.arrayBuffer()));
      execFileSync('tar', ['-xzf', archive, '-C', tmp], { stdio: 'ignore' });
      const extracted = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory());
      if (!extracted || !fs.existsSync(path.join(extracted, 'server.js'))) throw new Error('Archive inattendue : server.js absent');
      // Remplacement fichier par fichier, en préservant la configuration et les données locales.
      for (const name of fs.readdirSync(extracted)) {
        if (KEEP.has(name)) continue;
        const src = path.join(extracted, name);
        const dst = path.join(this.root, name);
        fs.rmSync(dst, { recursive: true, force: true });
        fs.cpSync(src, dst, { recursive: true });
      }
      fs.writeFileSync(this.file, JSON.stringify({ sha, date: this.latest.date, message: this.latest.message, installedAt: Date.now(), source: 'github' }), { mode: 0o600 });
      return this.status();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      this.busy = false;
    }
  }

  /** Redémarre : sous service (launchd/systemd), il suffit de quitter ; sous Windows, on relance la tâche planifiée. */
  scheduleRestart() {
    setTimeout(() => {
      if (process.platform === 'win32') {
        const vbs = path.join(this.root, 'start-relay.vbs');
        if (fs.existsSync(vbs)) {
          spawn('cmd.exe', ['/c', `timeout /t 3 /nobreak >nul && wscript.exe "${vbs}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }
      } else if (!process.env.RELAY_SERVICE) {
        // Lancé à la main (npm start) : on se relance nous-mêmes, détaché.
        spawn(process.execPath, [path.join(this.root, 'server.js')], { detached: true, stdio: 'ignore', cwd: this.root, env: process.env }).unref();
      }
      process.exit(0);
    }, 800).unref();
  }
}

export function osLabel() {
  return { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || os.platform();
}
