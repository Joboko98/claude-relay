import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

export function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(pin, salt, 32, SCRYPT_OPTS).toString('hex');
  return { salt, hash };
}

export function verifyPin(pin, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const hash = crypto.scryptSync(pin, salt, 32, SCRYPT_OPTS);
  const expected = Buffer.from(expectedHash, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

/**
 * Sessions (cookies) persistées sur disque + anti-bruteforce sur le PIN.
 */
export class Auth {
  constructor({ dataDir, config }) {
    this.config = config;
    this.file = path.join(dataDir, 'sessions.json');
    this.sessions = new Map();
    this.failures = { count: 0, lockedUntil: 0 };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [token, s] of Object.entries(raw)) this.sessions.set(token, s);
    } catch { /* pas encore de fichier */ }
    this.prune();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
  }

  prune() {
    const ttl = this.config.sessionDays * 86400_000;
    const now = Date.now();
    for (const [token, s] of this.sessions) {
      if (now - s.lastSeen > ttl) this.sessions.delete(token);
    }
  }

  /** @returns {{ok:true, token:string} | {ok:false, retryInMs:number}} */
  login(pin) {
    const now = Date.now();
    if (now < this.failures.lockedUntil) {
      return { ok: false, retryInMs: this.failures.lockedUntil - now };
    }
    if (typeof pin !== 'string' || !verifyPin(pin, this.config.pinSalt, this.config.pinHash)) {
      this.failures.count += 1;
      if (this.failures.count >= 3) {
        // 10 s, 20 s, 40 s… plafonné à 10 min
        const wait = Math.min(10_000 * 2 ** (this.failures.count - 3), 600_000);
        this.failures.lockedUntil = now + wait;
        return { ok: false, retryInMs: wait };
      }
      return { ok: false, retryInMs: 0 };
    }
    this.failures = { count: 0, lockedUntil: 0 };
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { createdAt: now, lastSeen: now });
    this.prune();
    this.save();
    return { ok: true, token };
  }

  check(token) {
    if (!token) return false;
    const s = this.sessions.get(token);
    if (!s) return false;
    if (Date.now() - s.lastSeen > this.config.sessionDays * 86400_000) {
      this.sessions.delete(token);
      this.save();
      return false;
    }
    s.lastSeen = Date.now();
    return true;
  }

  logout(token) {
    if (this.sessions.delete(token)) this.save();
  }
}
