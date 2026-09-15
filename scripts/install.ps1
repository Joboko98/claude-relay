# Installeur claude-relay pour Windows.
# Usage (PowerShell) :  irm <url de ce script> | iex
# Réinstallation / réparation : même commande ; la configuration et les données sont conservées.
$ErrorActionPreference = 'Stop'
$Repo   = if ($env:RELAY_REPO)   { $env:RELAY_REPO }   else { 'Joboko98/claude-relay' }
$Branch = if ($env:RELAY_BRANCH) { $env:RELAY_BRANCH } else { 'main' }
$Dir    = if ($env:RELAY_DIR)    { $env:RELAY_DIR }    else { Join-Path $env:USERPROFILE 'claude-relay' }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host ''
Write-Host '=== claude-relay : installation ===' -ForegroundColor Cyan

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '- Node.js absent : installation via winget…'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Null
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js introuvable après installation. Installe-le depuis https://nodejs.org puis relance.' }
}
Write-Host "- Node.js : $(node --version)"

# 2. Claude Code
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host '- Claude Code absent : installation…'
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Refresh-Path
}
if (Get-Command claude -ErrorAction SilentlyContinue) { Write-Host "- Claude Code : $(claude --version)" } else { Write-Warning 'Claude Code non détecté : ferme et rouvre PowerShell après l''installation, puis relance ce script.' }

# 3. Téléchargement de l'application
$token = $env:RELAY_TOKEN
if (-not $token -and -not $env:RELAY_NO_PROMPT) { $token = Read-Host 'Jeton GitHub de lecture (Entrée si le dépôt est public)' }
$headers = @{ 'User-Agent' = 'claude-relay-installer'; 'Accept' = 'application/vnd.github+json' }
if ($token) { $headers['Authorization'] = "Bearer $token" }
$tmp = Join-Path $env:TEMP ('claude-relay-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$archive = Join-Path $tmp 'app.tgz'
Write-Host "- Téléchargement de $Repo ($Branch)…"
try {
  Invoke-WebRequest -Uri "https://api.github.com/repos/$Repo/tarball/$Branch" -Headers $headers -OutFile $archive -UseBasicParsing
} catch {
  throw "Téléchargement impossible : $($_.Exception.Message). Dépôt privé sans jeton valide ?"
}
tar -xzf $archive -C $tmp
$src = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
if (-not (Test-Path (Join-Path $src.FullName 'server.js'))) { throw 'Archive inattendue (server.js absent).' }
New-Item -ItemType Directory -Path $Dir -Force | Out-Null
Get-ChildItem -Path $src.FullName -Force | ForEach-Object {
  if ($_.Name -in @('config.json', 'data', '.git')) { return }
  $dst = Join-Path $Dir $_.Name
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
  Copy-Item -Recurse -Force $_.FullName $dst
}
Remove-Item -Recurse -Force $tmp
Write-Host "- Application installée dans $Dir"

# 4. Configuration (PIN, source des mises à jour)
Set-Location $Dir
if (-not (Test-Path (Join-Path $Dir 'config.json'))) {
  node scripts/setup.js
} else {
  Write-Host '- Configuration existante conservée (PIN inchangé).'
}
$cfgScript = @"
const fs=require('fs');const p='config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));
c.updateRepo='$Repo';c.updateBranch='$Branch';if(process.env.RELAY_TOKEN)c.updateToken=process.env.RELAY_TOKEN;
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');
"@
$env:RELAY_TOKEN = $token
node -e $cfgScript
Remove-Item Env:RELAY_TOKEN

# 5. Connexion Claude (une seule fois)
$status = ''
try { $status = (claude auth status 2>$null | Out-String) } catch {}
if ($status -notmatch '"loggedIn":\s*true') {
  Write-Host '- Connexion à ton compte Claude : le navigateur va s''ouvrir.' -ForegroundColor Yellow
  claude auth login
}

# 6. Service (démarre à l'ouverture de session) et lancement
if ($env:RELAY_NO_SERVICE) { Write-Host "- Service non installé (RELAY_NO_SERVICE). Lance :  cd $Dir ; npm start"; return }
node scripts/service.js install
Start-Sleep -Seconds 2
Start-Process 'http://127.0.0.1:7777'
Write-Host ''
Write-Host 'Terminé. La page http://127.0.0.1:7777 est ouverte : tape ton PIN.' -ForegroundColor Green
Write-Host 'Mises à jour : dans l''app, Réglages → Mise à jour → Vérifier / Mettre à jour maintenant.'
