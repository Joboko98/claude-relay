import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectivePolicy, requiredReserve } from './policy.js';

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const WINDOWS = ['five_hour', 'seven_day'];
const BUCKET_USD = 1.0;      // un échantillon de calibrage par tranche d'environ 1 $ de consommation
const MAX_SAMPLES = 15;      // médiane glissante sur les derniers échantillons
const MIN_SAMPLES = 2;       // en dessous, l'estimation n'est pas utilisée pour le plafond

/**
 * Lit le jeton OAuth enregistré par `claude auth login` (jamais renvoyé au navigateur).
 * macOS : trousseau ; Windows/Linux : ~/.claude/.credentials.json
 */
export function readOAuth() {
  let raw = null;
  if (process.platform === 'darwin') {
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch { /* pas dans le trousseau */ }
  }
  if (!raw) {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    try { raw = fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'); } catch { /* absent */ }
  }
  if (!raw) return null;
  try { return JSON.parse(raw).claudeAiOauth || null; } catch { return null; }
}

function toMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function normalize(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (v && typeof v === 'object' && v.utilization != null) {
      const u = Number(v.utilization);
      if (!Number.isFinite(u)) continue;
      out[k] = { utilization: u, resets_at: toMillis(v.resets_at) };
    }
  }
  return out;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function fmtReset(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Utilisation du compte (fenêtre 5 h et semaine), comme /usage dans Claude Code,
 * plus deux mesures « ce poste » :
 *  - points observés : hausses du compteur du compte survenues pendant une tâche de la webapp
 *    (ou dans les minutes qui suivent). Borne haute si un autre appareil consomme en même temps.
 *  - estimation par le coût : Claude Code rapporte le coût de chaque tâche ; on le convertit en
 *    points avec un taux calibré sur les intervalles précédents (médiane, robuste aux chevauchements).
 *    Indépendant des autres appareils une fois calibré.
 */
export class Usage {
  constructor({ hub, config, dataDir = null, fetchImpl = globalThis.fetch, readCreds = readOAuth, minGapMs = 10_000 }) {
    this.hub = hub;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.readCreds = readCreds;
    this.minGapMs = minGapMs;
    this.file = dataDir ? path.join(dataDir, 'usage-local.json') : null;
    this.data = null;
    this.fetchedAt = 0;
    this.error = null;
    this.inflight = null;
    this.lastAttempt = 0;
    this.activeRuns = 0;
    this.dirty = false;      // une tâche s'est terminée depuis la dernière lecture
    this.lastRunEnd = 0;     // le comptage côté Anthropic arrive avec ~1 min de retard : période de grâce
    this.graceMs = 180_000;
    this.backoffUntil = 0;   // après un 429, on n'insiste pas avant cette date
    this.costSinceRead = 0;  // coût des tâches terminées depuis le dernier relevé
    this.homeEvents = [];    // hausses non attribuées à ce poste (donc à la maison) : { t, key, delta }
    this.local = {};         // par fenêtre : { resetsAt, lastSeen, points, cost }
    this.calib = {};         // par fenêtre : { samples: [ptsParDollar…], pendingCost, pendingPoints }
    this.loadLocal();
  }

  loadLocal() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.local = j.local || {};
      this.calib = j.calib || {};
    } catch { this.local = {}; this.calib = {}; }
  }

  saveLocal() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify({ local: this.local, calib: this.calib }), { mode: 0o600 }); } catch { /* disque */ }
  }

  ratio(key) {
    const c = this.calib[key];
    if (!c || c.samples.length < MIN_SAMPLES) return null;
    return median(c.samples.slice(-MAX_SAMPLES));
  }

  /** Valeur retenue pour le plafond « ce poste » : l'estimation si calibrée, sinon les points observés. */
  effective(key) {
    const l = this.local[key];
    if (!l) return null;
    const r = this.ratio(key);
    return r != null ? l.cost * r : l.points;
  }

  snapshot() {
    const local = {};
    for (const key of WINDOWS) {
      const l = this.local[key];
      if (!l) continue;
      const r = this.ratio(key);
      local[key] = {
        points: Math.max(0, Math.round(l.points * 10) / 10),
        cost: Math.round(l.cost * 100) / 100,
        estimate: r != null ? Math.round(l.cost * r * 10) / 10 : null,
        calibrated: r != null,
        samples: this.calib[key]?.samples.length || 0,
        effective: Math.round((this.effective(key) || 0) * 10) / 10,
        resetsAt: l.resetsAt,
      };
    }
    return {
      data: this.data,
      local,
      fetchedAt: this.fetchedAt,
      error: this.error,
      policy: this.policy(),
      barriers: this.barriers(),
      moment: this.moment(),
    };
  }

  policy() {
    return effectivePolicy(this.config);
  }

  /**
   * État des quatre barrières : pour chacune, la valeur courante, le seuil en vigueur et la marge
   * restante en points. `headroom` = marge minimale = ce que ce poste peut encore consommer.
   */
  barriers(now = Date.now()) {
    const p = this.policy();
    const out = [];
    const win = (key) => this.data?.[key];
    const localRow = (key, limit, label) => {
      const eff = this.effective(key);
      if (!(limit > 0) || eff == null) return;
      out.push({ id: `local_${key}`, label, kind: 'local', value: Math.round(eff * 10) / 10, threshold: limit, margin: Math.round((limit - eff) * 10) / 10 });
    };
    const reserveRow = (key, reserve, releaseMs, label) => {
      const w = win(key);
      if (!(reserve > 0) || !w) return;
      const required = requiredReserve(reserve, w.resets_at, releaseMs, now);
      const threshold = 100 - required;
      out.push({ id: `reserve_${key}`, label, kind: 'reserve', value: w.utilization, threshold: Math.round(threshold * 10) / 10, reserve, required: Math.round(required * 10) / 10, margin: Math.round((threshold - w.utilization) * 10) / 10 });
    };
    localRow('five_hour', p.sessionLocalLimitPercent, 'Part de ce poste, 5 h');
    localRow('seven_day', p.weeklyLocalLimitPercent, 'Part de ce poste, semaine');
    reserveRow('five_hour', p.sessionReservePercent, p.sessionReleaseHours * 3_600_000, 'Réserve maison, 5 h');
    reserveRow('seven_day', p.weeklyReservePercent, p.weeklyReleaseDays * 86_400_000, 'Réserve maison, semaine');
    const headroom = out.length ? Math.min(...out.map((b) => b.margin)) : null;
    return { list: out, headroom };
  }

  /** Hausses attribuées à la maison sur les N dernières minutes (points), et date de la dernière. */
  homeActivity(minutes = 30, now = Date.now()) {
    const since = now - minutes * 60_000;
    let pts = 0;
    let last = 0;
    for (const e of this.homeEvents) {
      if (e.key !== 'five_hour') continue; // la fenêtre 5 h bouge plus vite : meilleur signal d'activité
      if (e.t >= since) pts += e.delta;
      if (e.t > last) last = e.t;
    }
    return { points: Math.round(pts * 10) / 10, lastRiseAt: last || null };
  }

  /** Verdict « bon / moyen / mauvais moment » pour lancer une tâche depuis ce poste, avec ses raisons. */
  moment(now = Date.now()) {
    if (!this.data) return { level: 'unknown', title: 'Utilisation inconnue', reasons: [] };
    const { headroom } = this.barriers(now);
    const home30 = this.homeActivity(30, now);
    const home90 = this.homeActivity(90, now);
    const reasons = [];
    const f = this.data.five_hour;
    const w = this.data.seven_day;
    const fmtIn = (ms) => {
      const m = Math.max(0, Math.round((ms - now) / 60_000));
      return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`;
    };
    if (f) reasons.push(`Fenêtre 5 h : ${Math.round(100 - f.utilization)} % libres, réinitialisation dans ${fmtIn(f.resets_at)}.`);
    if (w) reasons.push(`Semaine : ${Math.round(100 - w.utilization)} % libres, réinitialisation dans ${w.resets_at ? Math.max(0, Math.round((w.resets_at - now) / 86_400_000 * 10) / 10) : '?'} j.`);
    if (headroom != null) reasons.push(headroom > 0 ? `Ce poste peut encore consommer environ ${Math.round(headroom)} points.` : 'Ce poste est bloqué par une barrière.');
    if (home30.points > 0) reasons.push(`Maison active : +${Math.round(home30.points)} points en 30 min.`);
    else if (home90.lastRiseAt) reasons.push(`Maison calme depuis ${fmtIn(now + (now - home90.lastRiseAt))}.`);
    else reasons.push('Aucune activité maison observée récemment.');

    let level = 'good';
    if (headroom != null && headroom <= 3) level = 'bad';
    else if (home30.points >= 3) level = 'bad';
    else if ((headroom != null && headroom < 10) || home30.points > 0) level = 'medium';
    const titles = { good: 'Bon moment', medium: 'Moment moyen', bad: 'Mauvais moment' };
    return { level, title: titles[level], reasons, headroom, home30: home30.points };
  }

  /** Appelé par le runner au démarrage d'une tâche : relève la base avant la hausse. */
  noteStart() {
    this.activeRuns += 1;
    this.refresh({ force: true }).catch(() => {});
  }

  /** Appelé par le runner à la fin d'une tâche, avec le coût rapporté par Claude Code. */
  noteEnd({ costUsd = 0 } = {}) {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    this.dirty = true;
    this.lastRunEnd = Date.now();
    const cost = Number(costUsd) || 0;
    this.costSinceRead += cost;
    for (const key of WINDOWS) if (this.local[key]) this.local[key].cost += cost;
    this.saveLocal();
    this.backoffUntil = 0; // le CLI vient de renouveler le jeton : on retente tout de suite
    this.refresh({ force: true }).catch(() => {});
    // Relevés différés : la hausse due à la tâche peut n'apparaître qu'une minute plus tard.
    for (const delay of [90_000, 200_000]) {
      const t = setTimeout(() => { this.refresh({ force: true }).catch(() => {}); }, delay);
      t.unref?.();
    }
  }

  resetLocal() {
    for (const key of WINDOWS) if (this.local[key]) { this.local[key].points = 0; this.local[key].cost = 0; }
    this.saveLocal();
    this.hub.broadcast({ type: 'usage', ...this.snapshot() });
  }

  refresh({ force = false } = {}) {
    if (this.inflight) return this.inflight;
    const now = Date.now();
    if (now < this.backoffUntil) return Promise.resolve(this.snapshot());
    const minGap = force ? this.minGapMs : Math.max(this.minGapMs, 60_000); // même forcé, jamais plus d'un relevé toutes les 10 s
    if (now - this.lastAttempt < minGap) return Promise.resolve(this.snapshot());
    this.lastAttempt = now;
    this.inflight = this.#fetch().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Attribue à ce poste les hausses observées pendant / juste après une tâche, et nourrit le calibrage. */
  attribute(data) {
    const now = Date.now();
    const quiet = this.activeRuns === 0 && now - this.lastRunEnd > this.graceMs;
    const attributable = this.activeRuns > 0 || this.dirty || !quiet;
    for (const key of WINDOWS) {
      const w = data[key];
      if (!w) continue;
      const l = this.local[key];
      // L'heure de réinitialisation fluctue de quelques millisecondes : nouvelle fenêtre au-delà de 5 min d'écart.
      if (!l || l.resetsAt == null || w.resets_at == null || Math.abs(l.resetsAt - w.resets_at) > 300_000) {
        this.local[key] = { resetsAt: w.resets_at, lastSeen: w.utilization, points: 0, cost: 0 };
        continue;
      }
      const delta = w.utilization - l.lastSeen;
      l.lastSeen = w.utilization;
      const c = this.calib[key] || (this.calib[key] = { samples: [], pendingCost: 0, pendingPoints: 0 });
      c.pendingCost += this.costSinceRead;
      if (delta > 0 && attributable) {
        l.points += delta;
        c.pendingPoints += delta;
      } else if (delta > 0) {
        this.homeEvents.push({ t: now, key, delta });
        this.homeEvents = this.homeEvents.filter((e) => now - e.t < 3 * 3_600_000);
      }
      // Un échantillon de calibrage se ferme au calme (points et coût alignés), par tranche de ~1 $.
      if (quiet && c.pendingCost >= BUCKET_USD) {
        c.samples.push(c.pendingPoints / c.pendingCost);
        if (c.samples.length > MAX_SAMPLES * 2) c.samples = c.samples.slice(-MAX_SAMPLES);
        c.pendingCost = 0;
        c.pendingPoints = 0;
      }
    }
    this.costSinceRead = 0;
    this.dirty = false;
    this.saveLocal();
  }

  async #fetch() {
    const oauth = this.readCreds();
    if (!oauth?.accessToken) {
      this.error = 'Jeton Claude Code introuvable : lance `claude auth login`.';
      return this.snapshot();
    }
    try {
      const r = await this.fetchImpl(ENDPOINT, {
        headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 401) {
        this.error = 'Jeton expiré : il sera renouvelé automatiquement au prochain message.';
      } else if (r.status === 429) {
        const wait = Math.min(600, Math.max(60, Number(r.headers?.get?.('retry-after')) || 60));
        this.backoffUntil = Date.now() + wait * 1000;
        this.error = `Relevé refusé (jeton à renouveler ou trop de relevés) : nouvel essai dans ${Math.round(wait / 60)} min, ou dès le prochain message.`;
      } else if (!r.ok) {
        this.error = `Utilisation indisponible (HTTP ${r.status}).`;
      } else {
        this.data = normalize(await r.json());
        this.fetchedAt = Date.now();
        this.error = null;
        this.attribute(this.data);
      }
    } catch (err) {
      this.error = `Utilisation indisponible : ${err.message}`;
    }
    this.hub.broadcast({ type: 'usage', ...this.snapshot() });
    return this.snapshot();
  }

  /** Message de blocage si une barrière est atteinte, sinon null. */
  blocked(now = Date.now()) {
    if (!this.data) return null;
    const p = this.policy();
    const reserves = [
      ['five_hour', p.sessionReservePercent, p.sessionReleaseHours * 3_600_000, 'la fenêtre de 5 h'],
      ['seven_day', p.weeklyReservePercent, p.weeklyReleaseDays * 86_400_000, 'la semaine'],
    ];
    for (const [key, reserve, releaseMs, label] of reserves) {
      const w = this.data[key];
      if (!(reserve > 0) || !w) continue;
      const required = requiredReserve(reserve, w.resets_at, releaseMs, now);
      if (w.utilization >= 100 - required) {
        return `Réserve maison : il ne reste que ${Math.round(100 - w.utilization)} % libres sur ${label}, réserve exigée en ce moment ${Math.round(required)} % (${reserve} % en plein, libérée progressivement). Réinitialisation ${fmtReset(w.resets_at)}.`;
      }
    }
    const locals = [
      ['seven_day', p.weeklyLocalLimitPercent, 'de la semaine'],
      ['five_hour', p.sessionLocalLimitPercent, 'de la fenêtre de 5 h'],
    ];
    for (const [key, limit, label] of locals) {
      const l = this.local[key];
      const eff = this.effective(key);
      if (limit > 0 && l && eff != null && eff >= limit) {
        const how = this.ratio(key) != null ? 'estimés d\'après le coût des tâches' : 'observés';
        return `Part de ce poste atteinte : ${Math.round(eff)} points ${label} ${how}, sur ${limit} autorisés. Réinitialisation ${fmtReset(l.resetsAt)}.`;
      }
    }
    return null;
  }
}
