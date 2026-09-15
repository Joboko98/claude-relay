import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const DATA_DIR = path.join(ROOT, 'data');

export const DEFAULTS = {
  host: '127.0.0.1',          // 0.0.0.0 pour accès depuis le réseau local / Tailscale
  port: 7777,
  claudePath: '',             // vide = détection automatique
  permissionMode: 'acceptEdits', // default | acceptEdits | plan | bypassPermissions
  confinement: 'none',        // none | sandbox (macOS/Linux : bac à sable système) | restricted (fichiers seulement)
  browseRoot: os.homedir(),   // racine de l'explorateur de dossiers de l'interface
  model: '',                  // vide = modèle par défaut du compte
  effort: '',                 // vide = défaut ; low | medium | high | xhigh | max
  defaultCwd: os.homedir(),   // dossier de travail par défaut des conversations
  lockOnHide: true,           // verrouiller dès que l'onglet est masqué
  lockAfterMinutes: 5,        // verrouiller après N minutes d'inactivité
  sessionDays: 30,            // durée de vie d'une session (cookie) côté serveur
  // Barrières de consommation (voir lib/policy.js). 0 = désactivé.
  sessionLocalLimitPercent: 0, // part maximale de la fenêtre 5 h consommée depuis CE poste (points de %)
  weeklyLocalLimitPercent: 0,  // idem pour la semaine
  sessionReservePercent: 0,    // ce poste s'arrête s'il reste moins de N % libres sur la fenêtre 5 h (réserve maison)
  weeklyReservePercent: 0,     // idem pour la semaine
  sessionReleaseHours: 2,      // réserve 5 h exigée en entier tant qu'il reste plus de N h, puis proportionnelle
  weeklyReleaseDays: 2,        // idem semaine, en jours
  updateRepo: '',              // dépôt GitHub « propriétaire/nom » pour le bouton Mettre à jour
  updateBranch: 'main',
  updateToken: '',             // jeton GitHub (lecture du contenu) si le dépôt est privé
  adminPublicKey: '',          // si renseignée : les barrières ne changent que par politique signée (poste administré)
  signedPolicy: '',            // dernière politique signée acceptée
  pinHash: '',
  pinSalt: '',
};

export function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  const cfg = { ...DEFAULTS, ...file };
  // Migration des anciens plafonds « total » vers les réserves maison.
  if (file.weeklyLimitPercent > 0 && !('weeklyReservePercent' in file)) cfg.weeklyReservePercent = 100 - file.weeklyLimitPercent;
  if (file.sessionLimitPercent > 0 && !('sessionReservePercent' in file)) cfg.sessionReservePercent = 100 - file.sessionLimitPercent;
  // Surcharges d'environnement (pratique pour les tests : RELAY_CLAUDE_PATH=scripts/fake-claude.js)
  if (process.env.RELAY_CLAUDE_PATH) cfg.claudePath = process.env.RELAY_CLAUDE_PATH;
  if (process.env.RELAY_PORT) cfg.port = Number(process.env.RELAY_PORT);
  return cfg;
}

export function saveConfig(cfg) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = cfg[k];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
}
