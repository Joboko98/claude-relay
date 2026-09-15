#!/usr/bin/env node
// Configuration initiale : code PIN + détection de `claude`.
import readline from 'node:readline';
import { CONFIG_PATH, loadConfig, saveConfig } from '../lib/config.js';
import { hashPin } from '../lib/auth.js';
import { findClaude } from '../lib/claude.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(question); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const cfg = loadConfig();

let pin = process.env.RELAY_PIN;
if (!pin) {
  if (cfg.pinHash) console.log('Un code PIN existe déjà ; en saisir un nouveau le remplace (Entrée pour le garder).');
  while (true) {
    pin = await ask('Code PIN (4 caractères minimum) : ', { hidden: true });
    if (!pin && cfg.pinHash) break;
    if (pin.length < 4) { console.log('Trop court.'); continue; }
    const again = await ask('Confirme le code : ', { hidden: true });
    if (again !== pin) { console.log('Les deux saisies diffèrent.'); continue; }
    break;
  }
}
if (pin) {
  const { salt, hash } = hashPin(pin);
  cfg.pinSalt = salt;
  cfg.pinHash = hash;
}

saveConfig(cfg);
console.log(`\nConfiguration écrite : ${CONFIG_PATH}`);

const bin = findClaude(cfg.claudePath);
if (bin) {
  console.log(`claude détecté : ${bin}`);
} else {
  console.log('claude INTROUVABLE. Installe Claude Code :');
  console.log('  curl -fsSL https://claude.ai/install.sh | bash');
  console.log('puis relance `npm run setup`, ou renseigne `claudePath` dans config.json.');
}
console.log(`
Étapes suivantes :
  1. Connecte Claude Code une seule fois sur ce poste :  claude   →  /login  (compte Google)
  2. Démarre :  npm start   (ou installe le service :  npm run service install)
  3. Ouvre     :  http://${cfg.host}:${cfg.port}
Réglages (config.json) : permissionMode, model, effort, lockOnHide, lockAfterMinutes, host/port.
`);
