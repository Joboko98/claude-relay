#!/usr/bin/env bash
# Installeur claude-relay pour macOS et Linux.
# Usage :  curl -fsSL <url de ce script> | bash
# Réinstallation / réparation : même commande ; la configuration et les données sont conservées.
set -euo pipefail
REPO="${RELAY_REPO:-Joboko98/claude-relay}"
BRANCH="${RELAY_BRANCH:-main}"
DIR="${RELAY_DIR:-$HOME/claude-relay}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo
echo "=== claude-relay : installation ==="

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then echo "- Node.js absent : installation via Homebrew…"; brew install node
  elif command -v apt-get >/dev/null 2>&1; then echo "- Node.js absent : installation via apt…"; sudo apt-get install -y nodejs npm
  else echo "Node.js absent : installe-le depuis https://nodejs.org puis relance ce script."; exit 1; fi
fi
echo "- Node.js : $(node --version)"

# 2. Claude Code
if ! command -v claude >/dev/null 2>&1; then
  echo "- Claude Code absent : installation…"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
[ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE_BIN="$HOME/.local/bin/claude"
if [ -n "$CLAUDE_BIN" ]; then echo "- Claude Code : $("$CLAUDE_BIN" --version) ($CLAUDE_BIN)"; else echo "Attention : Claude Code introuvable après installation. Vérifie avec :  curl -fsSL https://claude.ai/install.sh | bash"; fi

# 3. Téléchargement de l'application
TOKEN="${RELAY_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -z "${RELAY_NO_PROMPT:-}" ]; then
  read -r -p "Jeton GitHub de lecture (Entrée si le dépôt est public) : " TOKEN </dev/tty || TOKEN=""
fi
TMP="$(mktemp -d)"
AUTH=()
[ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")
echo "- Téléchargement de $REPO ($BRANCH)…"
if ! curl -fsSL "${AUTH[@]}" -H "Accept: application/vnd.github+json" -H "User-Agent: claude-relay-installer" "https://api.github.com/repos/$REPO/tarball/$BRANCH" -o "$TMP/app.tgz"; then
  echo "Téléchargement impossible : dépôt privé sans jeton valide ?"; exit 1
fi
tar -xzf "$TMP/app.tgz" -C "$TMP"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -f "$SRC/server.js" ] || { echo "Archive inattendue (server.js absent)."; exit 1; }
mkdir -p "$DIR"
for item in "$SRC"/* "$SRC"/.[!.]*; do
  [ -e "$item" ] || continue
  name="$(basename "$item")"
  case "$name" in config.json|data|.git) continue;; esac
  rm -rf "$DIR/$name"
  cp -R "$item" "$DIR/$name"
done
rm -rf "$TMP"
echo "- Application installée dans $DIR"

# 4. Configuration (PIN, source des mises à jour)
cd "$DIR"
if [ ! -f config.json ]; then
  if [ -n "${RELAY_PIN:-}" ]; then node scripts/setup.js; else node scripts/setup.js </dev/tty; fi
else echo "- Configuration existante conservée (PIN inchangé)."; fi
RELAY_TOKEN="$TOKEN" RELAY_REPO="$REPO" RELAY_BRANCH="$BRANCH" RELAY_CLAUDE="${CLAUDE_BIN:-}" node -e '
const fs=require("fs");const p="config.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));
c.updateRepo=process.env.RELAY_REPO;c.updateBranch=process.env.RELAY_BRANCH;if(process.env.RELAY_TOKEN)c.updateToken=process.env.RELAY_TOKEN;
if(process.env.RELAY_CLAUDE)c.claudePath=process.env.RELAY_CLAUDE;
fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");'

# 5. Connexion Claude (une seule fois)
if [ -n "${CLAUDE_BIN:-}" ] && [ -z "${RELAY_NO_SERVICE:-}" ] && ! "$CLAUDE_BIN" auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  echo "- Connexion à ton compte Claude : le navigateur va s'ouvrir."
  "$CLAUDE_BIN" auth login </dev/tty
fi

# 6. Service et lancement
if [ -n "${RELAY_NO_SERVICE:-}" ]; then echo "- Service non installé (RELAY_NO_SERVICE). Lance :  cd $DIR && npm start"; exit 0; fi
node scripts/service.js install
sleep 2
( command -v open >/dev/null && open "http://127.0.0.1:7777" ) || ( command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:7777" ) || true
echo
echo "Terminé. Ouvre http://127.0.0.1:7777 et tape ton PIN."
echo "Mises à jour : dans l'app, Réglages → Mise à jour → Vérifier / Mettre à jour maintenant."
