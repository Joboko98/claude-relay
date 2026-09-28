# Boîte aux lettres claude-relay

Petit service qui permet à un poste (le bureau) de publier sa propre consommation, et à un
autre poste (le portable) de la consulter, **sans rendre aucune machine joignable depuis
l'extérieur**. Seuls des chiffres transitent : points consommés, coût estimé, heure de la
dernière tâche, version de l'application. Aucun texte de conversation, aucun titre, aucun
jeton Claude.

## Mise en service, une seule fois

```bash
cd mailbox
npx wrangler kv namespace create RELEVES      # crée l'espace de stockage
# reporter l'identifiant renvoyé dans wrangler.jsonc, puis :
npx wrangler secret put RELAY_SECRET          # coller une phrase secrète longue
npx wrangler deploy
```

`wrangler deploy` affiche l'adresse du service, de la forme
`https://claude-relay-boite.<sous-domaine>.workers.dev`.

## Réglage des postes

Dans chaque application, ⚙ Réglages → « Postes distants » :

| Champ | Bureau | Portable |
|---|---|---|
| Adresse de la boîte | l'adresse ci-dessus | la même |
| Secret partagé | la phrase secrète | la même |
| Nom de ce poste | `bureau` | `portable` |
| Publier ma consommation | coché | au choix |
| Afficher les autres postes | au choix | coché |

Le bureau publie après chaque tâche et toutes les quinze minutes. Le portable affiche les
relevés sous ses propres barres de consommation.

## Coût et confidentialité

Le volume est dérisoire : quelques centaines d'octets toutes les quinze minutes, très en
deçà de l'offre gratuite de Cloudflare. Un relevé qu'aucun poste ne rafraîchit disparaît au
bout d'un mois. Le secret protège la lecture comme l'écriture : sans lui, le service ne
renvoie rien.
