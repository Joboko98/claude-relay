#!/usr/bin/env node
// Faux `claude` pour tester l'interface sans compte : rejoue un flux stream-json plausible.
// Usage : RELAY_CLAUDE_PATH=$PWD/scripts/fake-claude.js npm start
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', run);

const sid = process.argv[process.argv.indexOf('--session-id') + 1] || process.argv[process.argv.indexOf('--resume') + 1] || 'fake';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake', cwd: process.cwd() });
  const text = `Tu as écrit : « ${prompt.trim()} ».\n\nVoici une **réponse de test** avec du code :\n\n\`\`\`js\nconsole.log('bonjour');\n\`\`\`\n\n- point un\n- point deux`;
  const msgId = 'msg_' + Date.now();
  for (const chunk of text.match(/.{1,6}/gs)) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
    await sleep(40);
  }
  out({ type: 'assistant', message: { id: msgId, model: 'fake', content: [{ type: 'text', text }] } });
  await sleep(300);
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Bash' } } });
  await sleep(800);
  out({ type: 'assistant', message: { id: msgId, model: 'fake', content: [{ type: 'text', text }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la', description: 'Lister le dossier' } }] } });
  await sleep(600);
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'total 8\n-rw-r--r--  1 moi  staff  42 README.md' }] } });
  await sleep(400);
  const fin = 'Terminé : le dossier contient un README.';
  for (const chunk of fin.match(/.{1,5}/g)) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
    await sleep(40);
  }
  out({ type: 'assistant', message: { id: msgId + 'b', model: 'fake', content: [{ type: 'text', text: fin }] } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 4200, num_turns: 2, total_cost_usd: 0, session_id: sid, result: fin });
}
