import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Index des conversations (JSON) + transcript par conversation (JSONL).
 */
export class Store {
  constructor({ dataDir }) {
    this.dir = path.join(dataDir, 'conversations');
    this.indexFile = path.join(dataDir, 'index.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.convs = new Map();
    try {
      for (const c of JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))) this.convs.set(c.id, c);
    } catch { /* index vide */ }
    // Un serveur qui redémarre n'a plus aucun processus en cours.
    for (const c of this.convs.values()) if (c.status === 'running') c.status = 'idle';
  }

  saveIndex() {
    fs.writeFileSync(this.indexFile, JSON.stringify([...this.convs.values()], null, 2), { mode: 0o600 });
  }

  list() {
    return [...this.convs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.convs.get(id) || null;
  }

  create({ title, cwd, model = '', effort = '', confinement = '' }) {
    const now = Date.now();
    const conv = {
      id: crypto.randomUUID(),   // sert aussi de session_id Claude Code
      title: title || 'Nouvelle conversation',
      cwd,
      model,                      // vide = réglage global
      effort,                     // vide = réglage global
      confinement,                // vide = réglage global ; none | sandbox | restricted
      status: 'idle',
      started: false,             // true dès que Claude a créé la session
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    this.convs.set(conv.id, conv);
    this.saveIndex();
    return conv;
  }

  update(id, patch) {
    const conv = this.convs.get(id);
    if (!conv) return null;
    Object.assign(conv, patch, { updatedAt: Date.now() });
    this.saveIndex();
    return conv;
  }

  remove(id) {
    if (!this.convs.delete(id)) return false;
    this.saveIndex();
    try { fs.unlinkSync(this.transcriptFile(id)); } catch { /* absent */ }
    return true;
  }

  transcriptFile(id) {
    return path.join(this.dir, `${id}.jsonl`);
  }

  append(id, message) {
    const msg = { id: crypto.randomUUID(), ts: Date.now(), ...message };
    fs.appendFileSync(this.transcriptFile(id), JSON.stringify(msg) + '\n', { mode: 0o600 });
    return msg;
  }

  messages(id) {
    try {
      return fs.readFileSync(this.transcriptFile(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
