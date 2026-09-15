import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Cherche le binaire `claude` : config, PATH, emplacements usuels, app Claude Desktop. */
export function findClaude(configured) {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const names = win ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const candidates = [];
  if (configured) candidates.push(configured);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) for (const n of names) candidates.push(path.join(dir, n));
  }
  for (const n of names) candidates.push(path.join(home, '.local', 'bin', n));
  if (win) {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  } else {
    candidates.push(
      path.join(home, '.claude', 'local', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    );
  }
  const bundled = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(bundled).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(cmpVersion).reverse();
    for (const v of versions) {
      candidates.push(path.join(bundled, v, 'claude.app', 'Contents', 'MacOS', 'claude'));
    }
  } catch { /* pas de Claude Desktop */ }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch { /* suivant */ }
  }
  return null;
}

const MAX_TOOL_RESULT = 4000;

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
  }
  return '';
}

/**
 * Lance `claude -p` par conversation, parse le flux stream-json,
 * enregistre le transcript et diffuse les événements aux onglets.
 */
export class Runner {
  constructor({ store, hub, config, usage = null }) {
    this.store = store;
    this.hub = hub;
    this.config = config;
    this.usage = usage;
    this.active = new Map(); // convId -> run
  }

  get binary() {
    return findClaude(this.config.claudePath);
  }

  isRunning(id) {
    return this.active.has(id);
  }

  queueSize(id) {
    return this.active.get(id)?.queue.length || 0;
  }

  /**
   * @param {object} conv
   * @param {string} text
   * @param {Array<{path:string, rel:string, name:string, kind:'image'|'file', mime?:string, size?:number}>} attachments
   */
  send(conv, text, attachments = []) {
    const msg = this.store.append(conv.id, {
      role: 'user',
      text,
      attachments: attachments.map((a) => ({ path: a.path, rel: a.rel, name: a.name, kind: a.kind, mime: a.mime, size: a.size })),
    });
    this.store.update(conv.id, {});
    this.hub.broadcast({ conv: conv.id, type: 'message', message: msg });
    const payload = { text, attachments };
    const run = this.active.get(conv.id);
    if (run) {
      run.queue.push(payload);
      this.hub.broadcast({ conv: conv.id, type: 'queued', size: run.queue.length });
    } else {
      this.start(conv, payload);
    }
    return msg;
  }

  /** Construit ce qui est envoyé au CLI : texte enrichi des pièces jointes, et blocs image en base64. */
  buildPrompt(conv, { text, attachments = [] }) {
    const files = attachments.filter((a) => a.kind !== 'image');
    const images = attachments.filter((a) => a.kind === 'image');
    let prompt = text;
    if (files.length) {
      const relTo = (p) => path.relative(conv.cwd, p) || p;
      prompt += `\n\nPièces jointes déposées dans le dossier de travail (lis-les avec tes outils si besoin) :\n` +
        files.map((a) => `- ${relTo(a.path)}${a.size ? ` (${Math.round(a.size / 1024)} Ko)` : ''}`).join('\n');
    }
    const blocks = [];
    for (const img of images) {
      try {
        const buf = fs.readFileSync(img.path);
        if (buf.length > 5 * 1024 * 1024) { prompt += `\n\n(Image ${img.name} trop lourde pour être transmise directement ; elle est dans ${path.relative(conv.cwd, img.path)}.)`; continue; }
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/png', data: buf.toString('base64') } });
      } catch { prompt += `\n\n(Image ${img.name} illisible.)`; }
    }
    if (images.length) {
      prompt += `\n\nImages jointes : ${images.map((a) => a.name).join(', ')} (copies dans ${path.relative(conv.cwd, path.dirname(images[0].path))}).`;
    }
    blocks.push({ type: 'text', text: prompt });
    return { prompt, blocks, hasImages: blocks.length > 1 };
  }

  start(conv, payload, queue = []) {
    if (typeof payload === 'string') payload = { text: payload, attachments: [] };
    const built = this.buildPrompt(conv, payload);
    const bin = this.binary;
    if (!bin) {
      this.fail(conv, 'Binaire `claude` introuvable. Installe Claude Code sur cette machine, ou renseigne `claudePath` dans config.json.');
      return;
    }
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    let mode = this.config.permissionMode || 'acceptEdits';
    let confinement = conv.confinement || this.config.confinement || 'none';
    if (confinement === 'sandbox' && process.platform === 'win32') confinement = 'restricted'; // pas de bac à sable système sur Windows
    if (confinement === 'restricted') {
      // Retire Bash & co, cantonne les outils fichiers au dossier ; refuse bypassPermissions.
      args.push('--restricted');
      if (mode === 'bypassPermissions') mode = 'acceptEdits';
    } else if (confinement === 'sandbox') {
      // Bac à sable système : Bash tourne sans confirmation, mais écriture limitée au dossier et réseau coupé.
      args.push('--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }));
    }
    args.push('--permission-mode', mode);
    if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    if (built.hasImages) args.push('--input-format', 'stream-json');
    const model = conv.model || this.config.model;
    const effort = conv.effort || this.config.effort;
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push(conv.started ? '--resume' : '--session-id', conv.id);

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const cwd = conv.cwd && fs.existsSync(conv.cwd) ? conv.cwd : os.homedir();

    // Sur Windows, un wrapper .cmd (installation npm) doit passer par le shell.
    const viaShell = /\.cmd$/i.test(bin);
    const proc = spawn(viaShell ? `"${bin}"` : bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: viaShell, windowsHide: true });
    const run = { proc, queue, stderr: '', seen: new Map(), gotResult: false, killed: false, costUsd: 0 };
    this.active.set(conv.id, run);
    this.setStatus(conv.id, 'running');
    this.usage?.noteStart();

    proc.stdin.on('error', () => {});
    if (built.hasImages) {
      proc.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: built.blocks } }) + '\n');
    } else {
      proc.stdin.end(built.prompt);
    }

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      try { this.handle(conv.id, run, ev); } catch (err) { console.error('[runner] handle', err); }
    });
    proc.stderr.on('data', (d) => {
      run.stderr = (run.stderr + d).slice(-20_000);
    });
    proc.on('error', (err) => {
      this.active.delete(conv.id);
      this.fail(conv, `Impossible de lancer claude : ${err.message}`);
    });
    proc.on('close', (code) => this.finish(conv.id, run, code));
  }

  handle(convId, run, ev) {
    const sub = Boolean(ev.parent_tool_use_id);
    switch (ev.type) {
      case 'system': {
        if (ev.subtype === 'init') this.store.update(convId, { started: true });
        break;
      }
      case 'stream_event': {
        if (sub) break;
        const e = ev.event || {};
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          this.hub.broadcast({ conv: convId, type: 'delta', text: e.delta.text });
        } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          this.hub.broadcast({ conv: convId, type: 'tool_start', name: e.content_block.name });
        }
        break;
      }
      case 'assistant': {
        const m = ev.message || {};
        if (ev.error || m.model === '<synthetic>') {
          const text = this.explain(toolResultText(m.content) || ev.error || 'Erreur inconnue');
          run.lastError = text;
          this.push(convId, { role: 'error', text });
          break;
        }
        if (sub) break;
        const already = run.seen.get(m.id) || new Set();
        const blocks = [];
        for (const b of m.content || []) {
          let key;
          let block;
          if (b.type === 'text') {
            if (!b.text) continue;
            key = `t:${b.text}`;
            block = { type: 'text', text: b.text };
          } else if (b.type === 'tool_use') {
            key = `u:${b.id}`;
            block = { type: 'tool_use', id: b.id, name: b.name, input: b.input };
          } else {
            continue; // thinking, etc.
          }
          if (already.has(key)) continue;
          already.add(key);
          blocks.push(block);
        }
        run.seen.set(m.id, already);
        if (blocks.length) this.push(convId, { role: 'assistant', blocks });
        break;
      }
      case 'user': {
        if (sub) break;
        for (const b of ev.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          let text = toolResultText(b.content);
          if (text.length > MAX_TOOL_RESULT) text = text.slice(0, MAX_TOOL_RESULT) + `\n… (${text.length - MAX_TOOL_RESULT} caractères tronqués)`;
          this.push(convId, { role: 'tool_result', toolUseId: b.tool_use_id, text, isError: Boolean(b.is_error) });
        }
        break;
      }
      case 'result': {
        run.gotResult = true;
        run.costUsd = Number(ev.total_cost_usd) || 0;
        const errText = ev.is_error ? this.explain(ev.result || ev.subtype || 'erreur') : '';
        this.push(convId, {
          role: 'result',
          isError: Boolean(ev.is_error),
          text: errText === run.lastError ? '' : errText, // déjà affiché via le message d'erreur
          durationMs: ev.duration_ms,
          numTurns: ev.num_turns,
          costUsd: ev.total_cost_usd,
        });
        break;
      }
      default:
        break;
    }
  }

  explain(text) {
    if (/not logged in|\/login|authentication_failed/i.test(text)) {
      return `${text}\n\nClaude Code n'est pas connecté sur cette machine. Dans un terminal, lance \`claude\` puis \`/login\` (connexion Google), une seule fois.`;
    }
    if (/no conversation found|session.*not found/i.test(text)) {
      return `${text}\n\nLa session Claude de cette conversation n'existe plus sur ce poste. Crée une nouvelle conversation.`;
    }
    return text;
  }

  push(convId, message) {
    const msg = this.store.append(convId, message);
    this.store.update(convId, {});
    this.hub.broadcast({ conv: convId, type: 'message', message: msg });
    return msg;
  }

  finish(convId, run, code) {
    this.active.delete(convId);
    if (!run.gotResult && !run.killed) {
      const tail = run.stderr.trim().split('\n').slice(-15).join('\n');
      this.push(convId, { role: 'error', text: this.explain(`claude s'est arrêté (code ${code}).${tail ? `\n\n${tail}` : ''}`) });
    }
    if (run.killed) this.push(convId, { role: 'result', isError: false, stopped: true, text: 'Arrêté.' });
    this.setStatus(convId, 'idle');
    // Le CLI vient de rafraîchir son jeton : bon moment pour relire l'utilisation et l'attribuer à ce poste.
    this.usage?.noteEnd({ costUsd: run.costUsd });
    const conv = this.store.get(convId);
    if (conv && run.queue.length) {
      const [next, ...rest] = run.queue;
      this.start(conv, next, rest);
    }
  }

  fail(conv, text) {
    this.push(conv.id, { role: 'error', text });
    this.setStatus(conv.id, 'idle');
  }

  setStatus(convId, status) {
    this.store.update(convId, { status });
    this.hub.broadcast({ conv: convId, type: 'status', status });
  }

  stop(convId) {
    const run = this.active.get(convId);
    if (!run) return false;
    run.killed = true;
    run.queue = [];
    run.proc.kill('SIGINT');
    setTimeout(() => { if (this.active.get(convId) === run) run.proc.kill('SIGKILL'); }, 5000).unref();
    return true;
  }

  stopAll() {
    for (const id of [...this.active.keys()]) this.stop(id);
  }
}
