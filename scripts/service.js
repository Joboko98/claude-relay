#!/usr/bin/env node
// Lance le serveur en permanence : launchd (macOS), systemd --user (Linux), Planificateur de tâches (Windows).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, DATA_DIR, loadConfig } from '../lib/config.js';

const NAME = 'claude-relay';
const LOG = path.join(DATA_DIR, 'relay.log');
const ERR = path.join(DATA_DIR, 'relay.err.log');
const SERVER = path.join(ROOT, 'server.js');
const cmd = process.argv[2];

function run(bin, args) {
  try { return execFileSync(bin, args, { stdio: 'pipe' }).toString(); } catch (e) { return (e.stdout?.toString() || '') + (e.stderr?.toString() || ''); }
}
function done() {
  const cfg = loadConfig();
  console.log(`URL : http://${cfg.host}:${cfg.port}\nJournal : ${LOG}`);
}
function logs() {
  for (const f of [LOG, ERR]) {
    if (fs.existsSync(f)) { console.log(`--- ${f}`); console.log(fs.readFileSync(f, 'utf8').split('\n').slice(-40).join('\n')); }
  }
}
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// ---------- macOS ----------
function darwin() {
  const LABEL = 'com.claude-relay';
  const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const uid = process.getuid();
  switch (cmd) {
    case 'install': {
      fs.mkdirSync(path.dirname(PLIST), { recursive: true });
      const pathEnv = [path.dirname(process.execPath), `${os.homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
      fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${SERVER}</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${ERR}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${pathEnv}</string><key>HOME</key><string>${os.homedir()}</string><key>RELAY_SERVICE</key><string>1</string></dict>
</dict>
</plist>
`);
      run('launchctl', ['bootout', `gui/${uid}`, PLIST]);
      const out = run('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
      if (out.trim()) console.log(out.trim());
      console.log(`Service installé : ${PLIST}`);
      done();
      break;
    }
    case 'uninstall':
      run('launchctl', ['bootout', `gui/${uid}`, PLIST]);
      try { fs.unlinkSync(PLIST); } catch { /* absent */ }
      console.log('Service retiré.');
      break;
    case 'restart':
      console.log(run('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`]) || 'Relancé.');
      break;
    case 'status': {
      const out = run('launchctl', ['print', `gui/${uid}/${LABEL}`]);
      console.log(out.includes('state = running') ? 'En cours d\'exécution.' : (out.trim() ? out.split('\n').slice(0, 12).join('\n') : 'Non installé.'));
      break;
    }
    case 'logs': logs(); break;
    default: usage();
  }
}

// ---------- Linux ----------
function linux() {
  const UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', `${NAME}.service`);
  switch (cmd) {
    case 'install': {
      fs.mkdirSync(path.dirname(UNIT), { recursive: true });
      const pathEnv = [path.dirname(process.execPath), `${os.homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
      fs.writeFileSync(UNIT, `[Unit]
Description=claude-relay
After=network.target

[Service]
ExecStart=${process.execPath} ${SERVER}
WorkingDirectory=${ROOT}
Restart=always
RestartSec=3
Environment=PATH=${pathEnv}
Environment=RELAY_SERVICE=1
StandardOutput=append:${LOG}
StandardError=append:${ERR}

[Install]
WantedBy=default.target
`);
      run('systemctl', ['--user', 'daemon-reload']);
      console.log(run('systemctl', ['--user', 'enable', '--now', `${NAME}.service`]).trim());
      run('loginctl', ['enable-linger', os.userInfo().username]);
      console.log(`Service installé : ${UNIT}`);
      done();
      break;
    }
    case 'uninstall':
      run('systemctl', ['--user', 'disable', '--now', `${NAME}.service`]);
      try { fs.unlinkSync(UNIT); } catch { /* absent */ }
      run('systemctl', ['--user', 'daemon-reload']);
      console.log('Service retiré.');
      break;
    case 'restart': console.log(run('systemctl', ['--user', 'restart', `${NAME}.service`]) || 'Relancé.'); break;
    case 'status': console.log(run('systemctl', ['--user', 'status', '--no-pager', `${NAME}.service`]).split('\n').slice(0, 8).join('\n')); break;
    case 'logs': logs(); break;
    default: usage();
  }
}

// ---------- Windows ----------
function windows() {
  const TASK = 'ClaudeRelay';
  const VBS = path.join(ROOT, 'start-relay.vbs');
  switch (cmd) {
    case 'install': {
      // Lancement sans fenêtre visible, journal dans data/relay.log.
      fs.writeFileSync(VBS, `Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "${ROOT}"
sh.Environment("Process")("RELAY_SERVICE") = "1"
sh.Run "cmd /c """"${process.execPath}"" ""${SERVER}"" >> ""${LOG}"" 2>&1""", 0, False
`);
      run('schtasks', ['/Delete', '/TN', TASK, '/F']);
      console.log(run('schtasks', ['/Create', '/TN', TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', `wscript.exe "${VBS}"`]).trim());
      console.log(run('schtasks', ['/Run', '/TN', TASK]).trim());
      console.log('Tâche planifiée installée (démarre à l\'ouverture de session).');
      done();
      break;
    }
    case 'uninstall':
      console.log(run('schtasks', ['/Delete', '/TN', TASK, '/F']).trim());
      run('taskkill', ['/F', '/FI', `WINDOWTITLE eq ${NAME}*`]);
      console.log('Tâche retirée. Si le serveur tourne encore, arrête le processus node dans le Gestionnaire des tâches.');
      break;
    case 'restart':
      console.log('Arrête le processus node dans le Gestionnaire des tâches, puis :  schtasks /Run /TN ' + TASK);
      break;
    case 'status': console.log(run('schtasks', ['/Query', '/TN', TASK]).trim() || 'Non installée.'); break;
    case 'logs': logs(); break;
    default: usage();
  }
}

function usage() {
  console.log('Usage : npm run service -- install | uninstall | restart | status | logs');
}

if (process.platform === 'darwin') darwin();
else if (process.platform === 'linux') linux();
else if (process.platform === 'win32') windows();
else { console.error(`Plateforme non gérée : ${process.platform}`); process.exit(1); }
