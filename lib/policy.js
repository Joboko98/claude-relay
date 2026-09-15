import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Politique de consommation (les « barrières ») et son verrouillage par signature.
 * La clé privée vit sur le poste administrateur (la maison) ; le poste administré (le bureau)
 * ne connaît que la clé publique et n'accepte que des politiques signées, plus récentes que l'actuelle.
 */

export const POLICY_FIELDS = {
  sessionLocalLimitPercent: { min: 0, max: 100, label: 'Part de ce poste, fenêtre 5 h (%)' },
  weeklyLocalLimitPercent: { min: 0, max: 100, label: 'Part de ce poste, semaine (%)' },
  sessionReservePercent: { min: 0, max: 100, label: 'Réserve maison, fenêtre 5 h (%)' },
  weeklyReservePercent: { min: 0, max: 100, label: 'Réserve maison, semaine (%)' },
  sessionReleaseHours: { min: 0, max: 5, label: 'Libération progressive 5 h : pleine réserve au-delà de (h)' },
  weeklyReleaseDays: { min: 0, max: 7, label: 'Libération progressive semaine : pleine réserve au-delà de (jours)' },
};

/** Valeurs strictes appliquées si un verrou est posé mais qu'aucune politique valide n'est présente. */
export const STRICT_DEFAULTS = {
  sessionLocalLimitPercent: 60,
  weeklyLocalLimitPercent: 20,
  sessionReservePercent: 20,
  weeklyReservePercent: 30,
  sessionReleaseHours: 2,
  weeklyReleaseDays: 2,
};

export function validatePolicy(input) {
  const out = {};
  for (const [k, spec] of Object.entries(POLICY_FIELDS)) {
    const n = Number(input?.[k]);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) return { error: `Valeur invalide : ${spec.label}` };
    out[k] = Math.round(n * 100) / 100;
  }
  return { policy: out };
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** Clé d'administration (côté maison), stockée dans data/admin-key.json. */
export class AdminKey {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'admin-key.json');
  }

  exists() { return fs.existsSync(this.file); }

  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  create() {
    if (this.exists()) return this.publicKey();
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rec = {
      createdAt: Date.now(),
      publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' })),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(rec, null, 2), { mode: 0o600 });
    return rec.publicKey;
  }

  publicKey() { return this.load()?.publicKey || null; }

  /** Produit la chaîne « politique signée » : base64url(JSON).base64url(signature). */
  sign(policy, note = '') {
    const rec = this.load();
    if (!rec) throw new Error('Aucune clé d\'administration sur ce poste');
    const payload = { ...policy, issuedAt: Date.now(), note: String(note || '').slice(0, 120) };
    const data = Buffer.from(JSON.stringify(payload));
    const sig = crypto.sign(null, data, crypto.createPrivateKey(rec.privateKey));
    return `${b64u(data)}.${b64u(sig)}`;
  }
}

/** Vérifie une politique signée contre une clé publique ; renvoie { policy, issuedAt, note } ou { error }. */
export function verifySigned(signed, publicKeyB64) {
  try {
    const [d, s] = String(signed || '').trim().split('.');
    if (!d || !s) return { error: 'Format de politique invalide' };
    const data = unb64u(d);
    const key = crypto.createPublicKey({ key: unb64u(publicKeyB64), format: 'der', type: 'spki' });
    if (!crypto.verify(null, data, key, unb64u(s))) return { error: 'Signature invalide : cette politique ne vient pas de l\'administrateur' };
    const payload = JSON.parse(data.toString());
    const v = validatePolicy(payload);
    if (v.error) return v;
    if (!Number.isFinite(payload.issuedAt)) return { error: 'Politique sans date' };
    return { policy: v.policy, issuedAt: payload.issuedAt, note: String(payload.note || '') };
  } catch (err) {
    return { error: `Politique illisible : ${err.message}` };
  }
}

/** Politique effective d'un poste : signée si verrouillé, sinon les réglages locaux. */
export function effectivePolicy(config) {
  if (config.adminPublicKey) {
    const v = verifySigned(config.signedPolicy, config.adminPublicKey);
    if (v.error) return { ...STRICT_DEFAULTS, locked: true, valid: false, error: v.error, issuedAt: null, note: '' };
    return { ...v.policy, locked: true, valid: true, error: null, issuedAt: v.issuedAt, note: v.note };
  }
  const v = validatePolicy(config);
  return { ...(v.policy || STRICT_DEFAULTS), locked: false, valid: !v.error, error: v.error || null, issuedAt: null, note: '' };
}

/**
 * Réserve maison exigée en ce moment : pleine tant qu'il reste plus de `releaseMs` avant la
 * réinitialisation, puis proportionnelle au temps restant (la maison ne peut pas consommer
 * 20 % d'une fenêtre dans ses 20 dernières minutes).
 */
export function requiredReserve(reservePercent, resetsAt, releaseMs, now = Date.now()) {
  if (!reservePercent) return 0;
  if (!resetsAt || !releaseMs) return reservePercent;
  const remaining = Math.max(0, resetsAt - now);
  return reservePercent * Math.min(1, remaining / releaseMs);
}
