# claude-relay

Interface web **privée** (code PIN) par-dessus **Claude Code**, pensée pour un poste partagé :
tu connectes ton compte Claude une seule fois sur l'ordi du bureau, le serveur tourne en tâche
de fond, et tu dialogues avec Claude via une page verrouillée. Les tâches longues continuent
même quand tu n'es plus devant l'écran ; l'interface se verrouille dès que l'onglet est masqué
ou après quelques minutes d'inactivité, donc personne d'autre ne peut lire ni utiliser tes
conversations.

Fonctionne sur **macOS, Windows et Linux**. Aucune dépendance npm : Node ≥ 20 suffit.

## Installation en une ligne

Une seule commande fait tout : Node et Claude Code s'ils manquent, téléchargement de l'app,
choix du PIN, connexion à ton compte Claude, service de démarrage automatique, ouverture de la page.

- **Windows** (PowerShell) :
  ```powershell
  irm https://raw.githubusercontent.com/Joboko98/claude-relay/main/scripts/install.ps1 | iex
  ```
- **macOS / Linux** (Terminal) :
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Joboko98/claude-relay/main/scripts/install.sh | bash
  ```

Le dépôt est public : aucun jeton n'est nécessaire, ni à l'installation ni pour les mises à jour
(à la question « Jeton GitHub », appuie simplement sur Entrée). Relancer la même commande plus tard
répare ou réinstalle sans toucher au PIN, à la configuration ni aux conversations.

## Installation manuelle

1. Installer Node (https://nodejs.org, version LTS) puis Claude Code :
   - macOS / Linux : `curl -fsSL https://claude.ai/install.sh | bash`
   - Windows (PowerShell) : `irm https://claude.ai/install.ps1 | iex`
2. Se connecter **une seule fois** avec ton compte (Google) et attendre le message de succès :
   ```bash
   claude auth login
   ```
   Vérifier avec `claude auth status` (`"loggedIn": true`). Tu peux ensuite te déconnecter de
   Gmail : Claude garde son propre jeton, indépendant de ta session Google.
3. Copier ce dossier sur le poste, puis dans un terminal :
   ```bash
   cd claude-relay
   npm run setup          # choisit le code PIN, détecte claude
   npm start              # http://127.0.0.1:7777
   ```
4. Pour que ça tourne en permanence (démarrage à l'ouverture de session, relance si ça tombe) :
   ```bash
   npm run service -- install
   ```
   macOS : launchd · Linux : systemd --user · Windows : Planificateur de tâches (sans fenêtre).
   `npm run service -- status | logs | restart | uninstall` pour le reste.

## Dans l'interface

- **Modèle et effort** : par conversation (deux listes en haut de la conversation : Fable 5.1,
  Opus, Sonnet, Haiku ; effort faible → max) et par défaut dans ⚙ Réglages.
- **Utilisation** : en bas de la colonne de gauche, les mêmes pourcentages que `/usage` dans
  Claude Code (fenêtre de 5 h, semaine, et par modèle si ton forfait les distingue), avec
  l'heure de réinitialisation. Rafraîchi après chaque réponse et toutes les 5 minutes.
- **Les quatre barrières** (⚙ Réglages), toutes en points de pourcentage des fenêtres d'Anthropic :
  1. *Part de ce poste, fenêtre 5 h* (ex. 60) et 2. *Part de ce poste, semaine* (ex. 20) : ce que ce
     poste a le droit de consommer à lui seul, quoi que fassent les autres appareils.
  3. *Réserve maison, fenêtre 5 h* (ex. 20) et 4. *Réserve maison, semaine* (ex. 30) : ce poste
     s'arrête quand il reste moins que la réserve sur le compte entier. **Libération progressive** :
     la réserve exigée est entière tant qu'il reste plus de N heures (défaut 2 h) ou N jours (défaut
     2 j) avant la réinitialisation, puis diminue proportionnellement au temps restant. À 20 minutes
     de la fin d'une fenêtre de 5 h, une réserve de 20 % n'exige plus que 3 %.
  Une barrière atteinte bloque l'envoi de nouveaux messages depuis ce poste ; une tâche en cours
  finit son tour. 0 = barrière désactivée.
- **Bon ou mauvais moment** : encadré en haut de la colonne de gauche. Vert quand ce poste a de la
  marge (au moins 10 points avant la barrière la plus proche) et que la maison est calme ; orange
  si la marge est mince ou que la maison vient de consommer ; rouge si la marge est presque nulle
  ou que la maison est très active (3 points ou plus en 30 minutes). Les raisons sont listées :
  pourcentages libres, temps avant réinitialisation, marge du poste, activité maison.
- **Verrouillage par un poste administrateur** : pour que les barrières soient décidées à froid et
  non modifiables sur place.
  1. Sur le poste administrateur (la maison) : ⚙ → « Administrer un autre poste » → « Créer / afficher
     la clé ». Copie la clé publique. La clé privée reste dans `data/admin-key.json` de ce poste.
  2. Sur le poste administré (le bureau), une seule fois : ⚙ → « Verrouillage par un poste
     administrateur » → colle la clé publique → Enregistrer. Dès lors les champs de barrières et le
     bouton de remise à zéro sont en lecture seule, et tant qu'aucune politique valide n'est posée,
     des valeurs strictes s'appliquent (60 / 20 / 20 / 30).
  3. À chaque changement de barrières : sur le poste administrateur, renseigne les valeurs dans les
     champs, « Générer la politique signée », copie la chaîne ; sur le poste administré, colle-la dans
     « Nouvelle politique signée » → « Appliquer ». La signature est vérifiée avec la clé publique, et
     une politique plus ancienne que celle en vigueur est refusée : impossible de rejouer une ancienne
     politique plus généreuse.
  Retirer le verrou demande d'éditer `config.json` sur le poste administré et d'effacer
  `adminPublicKey` : c'est volontairement un geste à froid, pas un bouton.
- **Compteur « ce poste »** : sous la barre correspondante, avec un bouton de remise à zéro dans les
  réglages (désactivé si le poste est verrouillé). Il repart de zéro à chaque nouvelle fenêtre.
- **Dossier de travail** : bouton 📁 à côté du champ (nouvelle conversation ou ⚙ Réglages) pour
  parcourir les dossiers et en créer. L'explorateur reste sous `browseRoot` (ton dossier
  personnel par défaut).
- **Permissions des outils** (⚙ Réglages) : `acceptEdits` par défaut. Pour des tâches longues
  sans surveillance, passe en `bypassPermissions` : Claude n'a personne pour répondre à une
  demande de confirmation, donc tout ce qui n'est pas autorisé d'avance est refusé.
- **Confinement** (⚙ Réglages, et par conversation) : le dossier de travail n'est qu'un point
  de départ, il ne limite rien à lui seul. Pour vraiment cantonner Claude :
  - *Bac à sable* (macOS, Linux avec `bubblewrap`) : les commandes tournent sans confirmation
    mais ne peuvent écrire que dans le dossier, et le réseau est coupé. C'est le mode conseillé
    pour les tâches longues : autonome et confiné. Vérifié : écriture hors dossier refusée,
    `curl` bloqué.
  - *Fichiers seulement* (`--restricted`, toutes plateformes, y compris Windows) : plus aucune
    commande, lecture/écriture limitées au dossier. `bypassPermissions` est refusé dans ce mode.
  - *Aucun* : comportement normal de Claude Code.

## Mise à jour en un clic (GitHub)

Le projet vit dans un dépôt GitHub. Chaque poste sait se mettre à jour depuis ce dépôt :
⚙ Réglages → « Mise à jour » → « Vérifier » puis « Mettre à jour maintenant ». Le poste télécharge
la dernière version de la branche, remplace les fichiers de l'application (jamais `config.json`,
`data/`, le PIN, les conversations ni la clé d'administration), puis redémarre : automatiquement
sous service (launchd, systemd, tâche Windows) ; lancé à la main, il se relance lui-même.
La page se recharge seule quand le serveur est revenu. Une mise à jour est refusée tant qu'une
tâche est en cours. Le poste vérifie aussi tout seul toutes les 6 h et affiche « mise à jour
disponible » en bas à gauche.

Configuration, une seule fois par poste, dans ⚙ → « Source des mises à jour » :
- **Dépôt** : `propriétaire/nom` (ex. `yossef/claude-relay`).
- **Jeton GitHub** : inutile tant que le dépôt est public ; à renseigner seulement s'il redevient privé
  (jeton à grain fin limité à ce dépôt, permission *Contents : Read-only*).

Publier une nouvelle version depuis le poste de développement (le Mac) :
```bash
git add -A && git commit -m "description du changement" && git push
```
Les autres postes la voient au prochain « Vérifier ». Installation initiale d'un nouveau poste :
télécharger le ZIP du dépôt sur GitHub (bouton « Code » → « Download ZIP »), le décompresser,
puis suivre « Installation » ci-dessus ; les mises à jour suivantes se font par le bouton.

## Réglages (`config.json`)

Tout ce qui est dans ⚙ Réglages est enregistré ici. En plus :

| clé | défaut | rôle |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `7777` | mettre `0.0.0.0` pour y accéder depuis ton téléphone sur le réseau local ou via Tailscale |
| `claudePath` | auto | chemin du binaire `claude` si la détection échoue |
| `sessionDays` | `30` | durée de vie du cookie de session |

Relancer le serveur après modification manuelle.

## Sécurité

- PIN haché (scrypt), sessions par cookie `HttpOnly` + `SameSite=Strict`, en-tête anti-CSRF sur les écritures.
- Anti-bruteforce : 3 échecs puis délais croissants (10 s, 20 s, 40 s… jusqu'à 10 min).
- Verrouiller = déconnexion serveur (le cookie est invalidé), pas seulement un voile visuel.
- Le jeton Claude est lu localement pour afficher l'utilisation ; il n'est jamais envoyé au navigateur.
- Le serveur n'écoute que sur `127.0.0.1` par défaut. Si tu l'exposes sur le réseau, passe par
  Tailscale ou un tunnel HTTPS : le trafic n'est pas chiffré par l'application.
- Les transcripts sont dans `data/`. L'appli protège l'interface, pas le disque : quiconque
  ouvre ta session système peut lancer `claude` dans un terminal. Verrouille la session
  Windows/macOS quand tu pars, ou utilise un compte utilisateur à toi.

## Fonctionnement

Chaque message lance `claude -p … --output-format stream-json --resume <id>` dans le dossier de
travail de la conversation ; la réponse est diffusée en direct (SSE) et archivée en JSONL.
Si tu envoies plusieurs messages pendant que Claude travaille, ils sont mis en file et envoyés
à la suite. « Stop » interrompt le tour en cours.

Test sans compte : `RELAY_CLAUDE_PATH=$PWD/scripts/fake-claude.js npm start` rejoue un flux fictif.
